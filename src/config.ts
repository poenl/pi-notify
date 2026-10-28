/**
 * 配置：类型定义与解析。
 *
 * 配置文件：<agent 目录>/extensions/pi-notify/config.json，扩展加载时读一次。
 * 读不到或损坏时返回无自定义事件的空配置，完成/失败通知照常工作。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { nonEmptyString } from './payload'

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
export function loadConfig(): Config {
  try {
    return parseConfig(readFileSync(configPath(), 'utf8'))
  } catch {
    return EMPTY_CONFIG
  }
}
