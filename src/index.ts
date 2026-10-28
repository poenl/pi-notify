/**
 * pi-notify — pi 扩展：任务完成/失败、其他扩展等待用户输入时发系统通知（macOS / Windows / Linux）。
 *
 * 四块职责：
 * - 完成/失败：agent_settled 触发（彻底收工，含重试/压缩/排队跟进之后），正文取会话分支最后一条消息
 * - 自定义事件：配置文件声明哪些 pi.events 通道要通知，正文从事件负载取字段，不再为每个上游扩展改代码
 * - 失焦抑制：内建 DECSET 1004 焦点检测，仅终端失焦/后台时通知；终端不支持 1004 时收不到
 *   任何焦点事件，状态保持「失焦」，即每轮都通知
 * - 声音：完成类与失败两类音，完成类含需要用户处理的事件通知；配置 audio 可换成任意 wav，
 *   未指定则回退内置 complete.wav / error.wav；通知本身不带 sound
 *
 * 模块划分：config 配置解析、payload 负载取值、desktop 通知与声音、focus 焦点检测，
 * 本文件只做扩展接线与生命周期管理。
 */

import type { ExtensionAPI, SessionMessageEntry } from '@earendil-works/pi-coding-agent'
import { Container } from '@earendil-works/pi-tui'

import { loadConfig } from './config'
import { audioPath, notify, playAudio } from './desktop'
import { setupFocus } from './focus'
import { matchesWhen, pickText, truncate } from './payload'

/** agent_settled 里用来判断成败的字段；事件体不带消息，只能从会话分支取。 */
interface NotifyMessage {
  stopReason?: string
  errorMessage?: string
  content?: { type: string; text?: string }[]
}

export default function (pi: ExtensionAPI) {
  // 配置只在加载时读一次；事件订阅必须在工厂里完成，之后改配置需 /reload 或重启
  const config = loadConfig()

  /** 终端是否失焦；未知（终端不支持 1004）时保持 true，即照常通知。 */
  let terminalUnfocused = true
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
          playAudio(audioPath(config, 'success'))
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
        playAudio(audioPath(config, 'error'))
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
      playAudio(audioPath(config, 'success'))
      notify('✅ Task Complete', truncate(text) || '任务已完成')
    } catch {
      // 通知失败不影响 pi
    }
  })

  pi.on('session_shutdown', () => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
    cleanupFocus?.()
    cleanupFocus = undefined
    terminalUnfocused = true
  })
}
