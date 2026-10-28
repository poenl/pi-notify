/**
 * 桌面提醒：系统通知与提示音。
 *
 * 通知交给 node-notifier（macOS terminal-notifier、Windows/WSL snoretoast、Linux notify-send），
 * 参数以数组传给子进程，不做 shell 拼接，因此正文无需转义。
 * 音频按平台派发命令，找不到播放器或播放失败都静默，不影响 pi。
 */

import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
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
  if (process.env.WSL_DISTRO_NAME) return soundPlayer('powershell.exe', file)
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
