/**
 * pi-notify — pi 扩展：任务完成/失败、其他扩展等待用户输入时发 macOS 系统通知。
 *
 * 四块职责：
 * - 完成/失败：agent_settled 触发（彻底收工，含重试/压缩/排队跟进之后），正文取会话分支最后一条消息
 * - 自定义事件：配置文件声明哪些 pi.events 通道要通知，正文从事件负载取字段，不再为每个上游扩展改代码
 * - 失焦抑制：内建 DECSET 1004 焦点检测，仅终端失焦/后台时通知
 * - 声音：完成类与失败两类音，完成类含需要用户处理的事件通知；配置 audio 可换成任意 wav，
 *   未指定则回退内置 complete.wav / error.wav；osascript 通知不带 sound
 *
 * 配置文件：<agent 目录>/extensions/pi-notify/config.json，扩展加载时读一次。读不到就当没有自定义事件，
 * 完成/失败通知仍然工作。
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ExtensionAPI, SessionMessageEntry } from '@earendil-works/pi-coding-agent'
import { Container, type TUI } from '@earendil-works/pi-tui'

/** 配置文件里的音频路径；未指定的键回退内置提示音。 */
export interface AudioConfig {
  /** 完成类通知（含需要用户处理的事件）的音频文件路径 */
  success?: string
  /** 失败通知的音频文件路径 */
  error?: string
}

/** 文本来源：负载属性路径 + 取不到时的回退文本。title 与 body 共用这个结构。 */
export interface TextSource {
  /** 点号分隔的属性路径，逐层取值，如 data.label */
  path?: string
  /** 路径取不到（中间层缺失、不是对象、不是非空字符串）时的回退文本 */
  fallback?: string
}

/** 配置里单条自定义事件通知。 */
export interface EventRule {
  /** pi.events 通道名，任意字符串 */
  event: string
  /** 通知标题来源；path 与 fallback 都为空时该条规则被丢弃 */
  title: TextSource
  /** 正文来源；彻底取不到时正文回退到标题 */
  body?: TextSource
  /** 负载字段严格等值过滤，全部匹配才通知 */
  when?: Readonly<Record<string, string | number | boolean>>
}

/** 解析后的配置。 */
export interface Config {
  /** 自定义音频路径；未配置的键回退内置提示音 */
  audio?: AudioConfig
  events: EventRule[]
}

/** 无自定义事件：配置缺失、损坏或 events 为空时的共同结果。 */
const EMPTY_CONFIG: Config = { events: [] }

/** 声音文件目录：与 index.ts 同在 src/ 下，随包分发。 */
const SOUND_DIR = join(dirname(fileURLToPath(import.meta.url)), 'sounds')

/** 内置提示音：配置未指定音频时使用。 */
const BUILTIN_SOUNDS: Record<keyof AudioConfig, string> = {
  success: join(SOUND_DIR, 'complete.wav'),
  error: join(SOUND_DIR, 'error.wav')
}

/** 通知正文截断长度，完成通知与自定义事件共用。 */
const BODY_LIMIT = 120

/**
 * 配置路径：<agent 目录>/extensions/pi-notify/config.json。
 * 目录顺序与 pi 一致：PI_CODING_AGENT_DIR → $XDG_CONFIG_HOME/pi/agent → ~/.pi/agent
 */
function configPath(): string {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ??
    (process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, 'pi', 'agent')
      : join(homedir(), '.pi', 'agent'))
  return join(agentDir, 'extensions', 'pi-notify', 'config.json')
}

/** 非空字符串判定，供各字段校验复用。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** title/body 字段：只解析 { path, fallback } 结构；两者都空时视为未配置。 */
function parseTextSource(value: unknown): TextSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const path = nonEmptyString(raw.path)
  const fallback = nonEmptyString(raw.fallback)
  return path || fallback ? { path, fallback } : undefined
}

/** when 字段：只保留字符串/数字/布尔值；没有任何有效项时视为未配置。 */
function parseWhen(value: unknown): EventRule['when'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const when: Record<string, string | number | boolean> = {}
  for (const [key, expected] of Object.entries(value)) {
    if (['string', 'number', 'boolean'].includes(typeof expected)) {
      when[key] = expected as string | number | boolean
    }
  }
  return Object.keys(when).length ? when : undefined
}

/** audio 字段：两个键各自只保留非空字符串路径；都没给出时视为未配置。 */
function parseAudio(value: unknown): AudioConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const success = nonEmptyString(raw.success)
  const error = nonEmptyString(raw.error)
  return success || error ? { success, error } : undefined
}

/**
 * 解析配置文本。JSON 坏、根不是对象都整体视为无自定义事件；
 * events 缺失或不是数组时只是没有自定义事件，audio 仍然生效；
 * 单条规则缺 event 或 title 时丢弃该条，避免一条写错影响其余通知。
 */
export function parseConfig(raw: string): Config {
  try {
    const parsed: { events?: unknown; audio?: unknown } = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_CONFIG
    const items = Array.isArray(parsed.events) ? parsed.events : []
    const events: EventRule[] = []
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const rule = item as Record<string, unknown>
      const event = nonEmptyString(rule.event)
      const title = parseTextSource(rule.title)
      if (!event || !title) continue
      events.push({
        event,
        title,
        body: parseTextSource(rule.body),
        when: parseWhen(rule.when)
      })
    }
    return { audio: parseAudio(parsed.audio), events }
  } catch {
    return EMPTY_CONFIG
  }
}

/** 同步读配置：扩展加载时读一次，改配置需要重启 pi。 */
function loadConfig(): Config {
  try {
    return parseConfig(readFileSync(configPath(), 'utf8'))
  } catch {
    return EMPTY_CONFIG
  }
}

/** 负载字段严格等值过滤；未配置 when 时一律通过。 */
export function matchesWhen(data: unknown, when: EventRule['when']): boolean {
  if (!when) return true
  if (!data || typeof data !== 'object') return false
  const payload = data as Record<string, unknown>
  return Object.entries(when).every(([key, expected]) => payload[key] === expected)
}

/** 按点号路径逐层取值；中间层不是对象或最终值不是非空字符串时返回 undefined。 */
export function pickPath(data: unknown, path: string): string | undefined {
  let current: unknown = data
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return nonEmptyString(current)
}

/** 取文本来源的值：路径命中就用命中值，否则用 fallback（可能为空字符串）。 */
export function pickText(data: unknown, source: TextSource | undefined): string {
  if (!source) return ''
  const value = source.path ? pickPath(data, source.path) : undefined
  return value ?? source.fallback ?? ''
}

/** 截断长文本，避免通知被系统裁切；按码点切，不把 emoji 切成孤立代理项。 */
export function truncate(text: string): string {
  // Array.from 按码点拆分，slice 后再拼回去
  const chars = Array.from(text)
  return chars.length > BODY_LIMIT ? chars.slice(0, BODY_LIMIT - 1).join('') + '…' : text
}

/**
 * AppleScript 字符串字面量转义：正文拼进 display notification 的双引号内，
 * 不转义就能被构造串闭合引号后追加任意语句；回车/换行会破坏字面量，一并换成空格。
 */
export function escapeAppleScript(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, ' ')
}

/** 发系统通知：osascript 原生，零依赖。 */
function notify(title: string, body: string): void {
  // 空回调：命令不存在时 execFile 只发 'error' 事件，无人接收会抛未捕获异常并结束 pi 进程
  execFile(
    'osascript',
    [
      '-e',
      `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`
    ],
    () => {}
  )
}

/** 播放指定音频文件；播放失败静默。 */
function playAudio(path: string): void {
  // 空回调：afplay 或音频文件缺失时静默跳过，不影响通知也不影响 pi
  execFile('afplay', [path], () => {})
}

/**
 * 终端焦点检测（DECSET 1004）：终端获得焦点发 \x1b[I、失去焦点发 \x1b[O。
 * - 不用 ctx.ui.onTerminalInput：TuiAltScreen 的 viewport 输入监听器先注册并直接 consume
 *   焦点序列，扩展 handler 收不到，改在 process.stdin 原始层只读监听（多路广播，不抢 pi 的输入）
 * - 用 endsWith 匹配：焦点序列独立成块到达，且天然排除方向键 \x1b[OA~OD
 * - 终端不支持 1004 时忽略开启命令，状态保持「聚焦」，即不通知（安全回退）
 * 返回清理函数：移除监听 + 关闭焦点报告 + 复位状态。
 */
function setupFocus(tui: TUI, onChange: (unfocused: boolean) => void): () => void {
  tui.terminal.write('\x1b[?1004h')
  onChange(false)

  const onRawStdin = (data: Buffer | string) => {
    const text = String(data)
    if (text.endsWith('\x1b[O')) onChange(true)
    else if (text.endsWith('\x1b[I')) onChange(false)
  }
  process.stdin.on('data', onRawStdin)

  return () => {
    process.stdin.removeListener('data', onRawStdin)
    tui.terminal.write('\x1b[?1004l')
    onChange(false)
  }
}

/** agent_settled 里用来判断成败的字段；事件体不带消息，只能从会话分支取。 */
interface NotifyMessage {
  stopReason?: string
  errorMessage?: string
  content?: { type: string; text?: string }[]
}

export default function (pi: ExtensionAPI) {
  // 配置只在加载时读一次；事件订阅必须在工厂里完成，之后改配置需 /reload 或重启
  const config = loadConfig()

  /** 取音频路径：配置指定且文件存在才用，否则回退内置提示音。 */
  const audioPath = (kind: keyof AudioConfig) => {
    const configured = config.audio?.[kind]
    return configured && existsSync(configured) ? configured : BUILTIN_SOUNDS[kind]
  }

  /** 终端是否失焦；未知（终端不支持 1004）时保持 false，即不通知。 */
  let terminalUnfocused = false
  /** 自定义事件的退订函数，session_shutdown 统一清理。 */
  const unsubscribers: (() => void)[] = []
  /** 焦点检测的清理函数，由 session_start 的 setWidget 回调建立。 */
  let cleanupFocus: (() => void) | undefined

  for (const rule of config.events) {
    unsubscribers.push(
      pi.events.on(rule.event, (data) => {
        try {
          // 只通知配置里明确等值匹配的事件，避免上游扩展的无关广播也弹通知
          if (!matchesWhen(data, rule.when)) return
          // 聚焦抑制：用户正在终端操作时不打扰
          if (!terminalUnfocused) return
          // 标题取不到又没回退文本时发出去只有空标题，直接跳过
          const title = truncate(pickText(data, rule.title))
          if (!title) return
          // 事件通知属于「需要你处理」，归入完成类音效
          playAudio(audioPath('success'))
          const body = truncate(pickText(data, rule.body))
          notify(title, body || title)
        } catch {
          // 通知失败不影响 pi
        }
      })
    )
  }

  pi.on('session_start', (_event, ctx) => {
    // 用空 widget factory 拿真 TUI：焦点序列要写进终端，必须走 tui.terminal
    ctx.ui.setWidget(
      'pi-notify:focus-bridge',
      (tui) => {
        cleanupFocus = setupFocus(tui, (unfocused) => {
          terminalUnfocused = unfocused
        })
        return new Container() // 空组件占位（仅用于拿 tui）
      },
      { placement: 'belowEditor' }
    )
  })

  pi.on('agent_settled', (_event, ctx) => {
    try {
      // 聚焦抑制：仅终端窗口失焦才通知；聚焦/未知一律静默
      if (!terminalUnfocused) return

      // 事件体只有 { type }，改从会话分支取最后一条消息判断本轮成败
      const last = ctx.sessionManager
        .getBranch()
        .filter((entry): entry is SessionMessageEntry => entry.type === 'message')
        .at(-1)?.message as NotifyMessage | undefined
      const isError = last?.stopReason === 'error' || Boolean(last?.errorMessage)

      if (isError) {
        playAudio(audioPath('error'))
        // 错误消息可能上千字符，与完成通知共用同一截断长度
        notify('❌ Task Failed', truncate(last?.errorMessage ?? '任务失败'))
        return
      }
      // 完成：最后 assistant 文本（截断 120 字符），完成音 complete.wav
      const text =
        last?.content
          ?.filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('')
          .trim() ?? ''
      playAudio(audioPath('success'))
      notify('✅ Task Complete', truncate(text) || '任务已完成')
    } catch {
      // 通知失败不影响 pi
    }
  })

  pi.on('session_shutdown', () => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
    cleanupFocus?.()
    cleanupFocus = undefined
    terminalUnfocused = false
  })
}
