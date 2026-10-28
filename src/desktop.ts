/**
 * 桌面提醒：系统通知与提示音。
 *
 * 通知交给 node-notifier（macOS terminal-notifier、Windows/WSL snoretoast、Linux notify-send），
 * 参数以数组传给子进程，不做 shell 拼接，因此正文无需转义。
 * 音频按平台派发命令，找不到播放器或播放失败都静默，不影响 pi。
 */

import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import notifier from 'node-notifier'

import type { AudioConfig, Config } from './config'

/** 声音文件目录：与源码同在 src/ 下，随包分发。 */
const SOUND_DIR = join(dirname(fileURLToPath(import.meta.url)), 'sounds')

/** 内置提示音：配置未指定音频时使用。 */
const BUILTIN_SOUNDS: Record<keyof AudioConfig, string> = {
  success: join(SOUND_DIR, 'complete.wav'),
  error: join(SOUND_DIR, 'error.wav')
}

/** 发系统通知：node-notifier 按平台选实现，缺命令时只回调错误。 */
export function notify(title: string, body: string): void {
  // 空回调：目标平台缺命令（如 Linux 无 notify-send）时不影响 pi
  notifier.notify({ title, message: body }, () => {})
}

/** 交互式通知的入参：只有输入框，按钮那条线没有调用者，已删除。 */
export interface AskNotifyOptions {
  title: string
  body: string
  /** 输入框占位文字；仅 macOS 生效，其他平台不显示 */
  reply?: string
}

/** 是否 WSL：Linux 上借 Windows 侧的通知与音频。 */
export function isWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME)
}

/** 交互式通知的实现分支；抽成纯函数，三平台分支才能被测试覆盖。 */
export function notificationChannel(platform: string, wsl: boolean): 'mac' | 'windows' | 'linux' {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32' || wsl) return 'windows'
  return 'linux'
}

/** macOS 交互通知等待时长（秒）：超过后通知被系统移除并返回 undefined。 */
const MAC_TIMEOUT_SECONDS = 600

/**
 * macOS 调 terminal-notifier 的参数。
 * 不能用 node-notifier：它给每个参数加字面双引号，参数会被系统当成带引号的字面量。
 * 不传 -timeout 会一直等，进程不退，所以固定给一个上限。
 */
export function macArgs(options: AskNotifyOptions): string[] {
  const args = [
    '-title',
    options.title,
    '-message',
    options.body,
    '-json',
    '-timeout',
    String(MAC_TIMEOUT_SECONDS)
  ]
  if (options.reply) args.push('-reply', options.reply)
  return args
}

/** terminal-notifier 二进制位置：随 node-notifier 装进 vendor，版本固定才拼得出来。 */
function terminalNotifierPath(): string {
  const entry = createRequire(import.meta.url).resolve('node-notifier')
  return join(
    dirname(entry),
    'vendor',
    'mac.noindex',
    'terminal-notifier.app',
    'Contents',
    'MacOS',
    'terminal-notifier'
  )
}

/** 等待中的 macOS 通知进程：不 kill 的话，管道会让 Node 事件循环一直不退出。 */
const pendingNotifications = new Set<ChildProcess>()

/** 结束所有等待中的交互通知：同一时刻只保留最新一条，旧的回复已无意义。 */
export function killPendingNotifications(): void {
  for (const child of pendingNotifications) child.kill()
  pendingNotifications.clear()
}

/** macOS：直连二进制，读 stdout JSON 里的 activationValue（输入文本）。 */
function askMac(options: AskNotifyOptions): Promise<string | undefined> {
  return new Promise((resolve) => {
    // 新通知顶掉旧的：否则上一轮遗留的输入框还会有人回，发出过时指令
    killPendingNotifications()
    // 失败一律 resolve(undefined)：没有通知也不影响 pi
    const child = execFile(terminalNotifierPath(), macArgs(options), (error, stdout) => {
      pendingNotifications.delete(child)
      if (error) return resolve(undefined)
      try {
        const { activationValue } = JSON.parse(stdout) as { activationValue?: string }
        resolve(activationValue || undefined)
      } catch {
        resolve(undefined)
      }
    })
    pendingNotifications.add(child)
  })
}

/**
 * Windows / WSL：SnoreToast 的输入框实测提交后不回传文本，所以只发普通通知、不发输入框，
 * 结果永远是 undefined。
 */
function askWindows(options: AskNotifyOptions): Promise<string | undefined> {
  notify(options.title, options.body)
  return Promise.resolve(undefined)
}

/**
 * 统一的交互式通知：返回输入框里提交的文本，未响应或平台不支持时为 undefined。
 * Linux 的 notify-send 既不能等也不读结果，只发普通通知。
 * platform / wsl 可注入，便于测试三平台分支。
 */
export function askNotify(
  options: AskNotifyOptions,
  platform: string = process.platform,
  wsl: boolean = isWsl()
): Promise<string | undefined> {
  const channel = notificationChannel(platform, wsl)
  if (channel === 'mac') return askMac(options)
  if (channel === 'windows') return askWindows(options)
  notify(options.title, options.body)
  return Promise.resolve(undefined)
}

/** 取音频路径：配置指定且文件存在才用，否则回退内置提示音。 */
export function audioPath(config: Config, kind: keyof AudioConfig): string {
  const configured = config.audio?.[kind]
  return configured && existsSync(configured) ? configured : BUILTIN_SOUNDS[kind]
}

/** 一条播放命令：可执行文件与参数。 */
type Playback = readonly [string, readonly string[]]

/** Linux 播放器候选及各自播放指定文件的参数，按优先级探测。 */
const LINUX_PLAYERS: readonly (readonly [string, (file: string) => string[]])[] = [
  ['paplay', (file) => [file]],
  ['aplay', (file) => [file]],
  ['ffplay', (file) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', file]]
]

/** 在 PATH 中查找可执行文件；存在但不可执行也视为没有，避免 spawn 报错后彻底静音。 */
function hasCommand(name: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => {
    if (dir === '') return false
    try {
      accessSync(join(dir, name), constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/** PowerShell 的 SoundPlayer 播放命令；单引号是字符串定界符，路径内的单引号要写成两个。 */
function soundPlayer(exe: string, file: string): Playback {
  const quoted = file.replace(/'/g, "''")
  return [exe, ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${quoted}').PlaySync()`]]
}

/**
 * 选音频播放命令：macOS 用 afplay；Windows 用 PowerShell 的 SoundPlayer；WSL 里没有 Linux
 * 桌面音频，改调 Windows 侧的 powershell.exe；Linux 依次探测 paplay / aplay / ffplay。
 * has 可注入，便于测试；找不到任何播放器时返回 undefined。
 */
export function audioCommand(
  platform: string,
  file: string,
  has: (name: string) => boolean = hasCommand
): Playback | undefined {
  if (platform === 'darwin') return ['afplay', [file]]
  if (platform === 'win32') return soundPlayer('powershell', file)
  if (isWsl()) return soundPlayer('powershell.exe', file)
  for (const [name, args] of LINUX_PLAYERS) {
    if (has(name)) return [name, args(file)]
  }
  return undefined
}

/** 播放指定音频文件；没有可用播放器或播放失败都静默。 */
export function playAudio(path: string): void {
  const playback = audioCommand(process.platform, path)
  if (!playback) return
  // 空回调：命令缺失或音频文件损坏时静默跳过，不影响通知也不影响 pi
  execFile(playback[0], [...playback[1]], () => {})
}
