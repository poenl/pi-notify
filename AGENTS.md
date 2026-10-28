# AGENTS.md

pi 扩展：任务完成/失败、其他扩展等待用户输入时，发系统通知（macOS / Windows / Linux），仅终端失焦时通知。

## 项目结构

- `src/index.ts`：扩展接线：配置读取、事件订阅、`agent_settled` 完成/失败判断、会话生命周期
- `src/config.ts`：配置类型与解析（`parseConfig` / `loadConfig`）
- `src/payload.ts`：事件负载过滤与取值（`matchesWhen` / `pickPath` / `pickText` / `truncate`）
- `src/desktop.ts`：系统通知（`notify`）与提示音（`audioCommand` / `playAudio` / `audioPath`）
- `src/focus.ts`：DECSET 1004 焦点检测（`setupFocus`）
- `src/sounds/complete.wav`、`src/sounds/error.wav`：内置提示音，配置未指定音频时使用
- `tests/notify.test.ts`：`parseConfig` / `matchesWhen` / `pickPath` / `pickText` / `truncate` / `audioCommand` 的用例

## 常用命令

- pnpm check：tsc + eslint（必须全绿）
- pnpm test：vitest（必须全绿）
- pnpm format：prettier 写格式

## 行为要点

- 配置文件 `~/.pi/agent/extensions/pi-notify/config.json`，扩展加载时读一次，改配置需重启或 `/reload`
- 配置损坏、`events` 缺失或为空：不订阅任何自定义事件，完成/失败通知照常
- 自定义事件：`pi.events.on(rule.event)`，先 `when` 严格等值过滤，再要求终端失焦；标题与正文都是「点号属性路径 + `fallback`」，逐层取值，取不到用回退文本
- 标题取不到（`path` 未命中且无 `fallback`）时整条通知跳过，不播声音；未提交测试覆盖，改动这段时手工验证
- 声音：配置 `audio.success` / `audio.error` 可指定任意 wav，未指定回退内置；自定义事件通知归入 `success`
- 音频播放：macOS `afplay`；Windows `powershell` 的 SoundPlayer；WSL 调 `powershell.exe`；Linux 依次探测 `paplay` / `aplay` / `ffplay`，都没有则静默
- 通知：`node-notifier` 按平台分派（macOS terminal-notifier、Windows/WSL snoretoast、Linux notify-send），参数走数组不做 shell 拼接
  - macOS 通知来自未签名 terminal-notifier.app：需在「系统设置 → 通知」允许并设为横幅，否则不弹；其二进制只有 x86_64（需 Rosetta），重装依赖后可能需重新授权
- 完成/失败：`agent_settled`（不是 `agent_end`——后者之后 pi 可能继续自动干活，会提前或重复通知），
  正文来自会话分支最后一条消息，不走事件负载
- 焦点检测：`process.stdin` 原始层只读监听 `\x1b[O` / `\x1b[I`，不能用 `ctx.ui.onTerminalInput`
  （TuiAltScreen 的 viewport 监听器先注册且 consume 焦点序列）
- 终端不支持 1004 时收不到任何焦点事件，状态保持「失焦」→ 每轮都通知；支持 1004 的终端关闭开关时会回发当前
  焦点状态，据此自动纠正
