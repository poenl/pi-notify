# AGENTS.md

pi 扩展：任务完成/失败、其他扩展等待用户输入时，发 macOS 系统通知（osascript），仅终端失焦时通知。

## 项目结构

- `src/index.ts`：配置解析（`parseConfig` / `loadConfig`）+ 事件订阅 + `agent_settled` 完成/失败判断
  - 内建 DECSET 1004 焦点检测（`setupFocus`）
- `src/sounds/complete.wav`、`src/sounds/error.wav`：afplay 播放的内置提示音，配置未指定音频时使用
- `tests/notify.test.ts`：`parseConfig` / `matchesWhen` / `pickPath` / `pickText` / `truncate` 的用例

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
- 完成/失败：`agent_settled`（不是 `agent_end`——后者之后 pi 可能继续自动干活，会提前或重复通知），
  正文来自会话分支最后一条消息，不走事件负载
- 焦点检测：`process.stdin` 原始层只读监听 `\x1b[O` / `\x1b[I`，不能用 `ctx.ui.onTerminalInput`
  （TuiAltScreen 的 viewport 监听器先注册且 consume 焦点序列）
- 终端不支持 1004 时状态保持「聚焦」→ 永不通知，这是安全回退
