/**
 * 终端焦点检测（DECSET 1004）：终端获得焦点发 \x1b[I、失去焦点发 \x1b[O。
 *
 * - 不用 ctx.ui.onTerminalInput：TuiAltScreen 的 viewport 输入监听器先注册并直接 consume
 *   焦点序列，扩展 handler 收不到，改在 process.stdin 原始层只读监听（多路广播，不抢 pi 的输入）
 * - 用 endsWith 匹配：焦点序列独立成块到达，且天然排除方向键 \x1b[OA~OD
 * - 终端不支持 1004 时忽略开启命令，收不到任何事件，状态保持「失焦」即每轮都通知
 * - 支持 1004 的终端会在开启时回发当前焦点状态（VTE 明确实现），据此自动纠正初值
 * 返回清理函数：移除监听 + 关闭焦点报告 + 复位状态。
 */

import type { TUI } from '@earendil-works/pi-tui'

export function setupFocus(tui: TUI, onChange: (unfocused: boolean) => void): () => void {
  tui.terminal.write('\x1b[?1004h')
  onChange(true)

  const onRawStdin = (data: Buffer | string) => {
    const text = String(data)
    if (text.endsWith('\x1b[O')) onChange(true)
    else if (text.endsWith('\x1b[I')) onChange(false)
  }
  process.stdin.on('data', onRawStdin)

  return () => {
    process.stdin.removeListener('data', onRawStdin)
    tui.terminal.write('\x1b[?1004l')
    onChange(true)
  }
}
