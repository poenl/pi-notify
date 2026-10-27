**简体中文** | [English](README.md)

# pi-notify

pi 扩展：任务完成或失败、以及其他扩展等待你输入时，发 macOS 系统通知。

## 效果

| 时机         | 通知                                                  | 声音    |
| ------------ | ----------------------------------------------------- | ------- |
| 本轮正常收尾 | ✅ Task Complete —— 最后一段回复文本（截断 120 字符） | success |
| 本轮失败     | ❌ Task Failed —— 错误信息                            | error   |

只在**终端窗口失焦**时通知。你正看着终端时不会弹任何东西。

## 安装

从 git 仓库安装：

```bash
pi install git:github.com/poenl/pi-notify
```

临时试用（仅当前进程，不写 settings）：

```bash
pi -e git:github.com/poenl/pi-notify
```

依赖 macOS（`osascript`、`afplay`）与 Node >= 22。

## 配置其他扩展的事件

任意 `pi.events` 通道都可以在配置文件里映射成通知，不需要改代码。

配置文件：`~/.pi/agent/extensions/pi-notify/config.json`。

```json
{
  "audio": {
    "success": "/Users/you/ok.wav",
    "error": "/Users/you/fail.wav"
  },
  "events": [
    {
      "event": "example-ext:needs-input",
      "title": { "path": "data.name", "fallback": "❓ 需要你回答" },
      "body": { "path": "data.message", "fallback": "等待你的输入" },
      "when": { "active": true }
    },
    {
      "event": "example-ext:needs-approval",
      "title": { "fallback": "🔐 需要你批准" },
      "body": { "path": "data.detail", "fallback": "操作" }
    }
  ]
}
```

| 字段            | 必填 | 含义                                                                                                                                                           |
| --------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event`         | 是   | `pi.events` 通道名                                                                                                                                             |
| `title`         | 是   | 标题来源：`path` 是点号属性路径，逐层取值，取不到用 `fallback`；两者都空则该条规则丢弃                                                                         |
| `body`          | 否   | 正文来源，结构同 `title`；取不到时正文回退到标题                                                                                                               |
| `when`          | 否   | 上游扩展把多种情况广播到同一通道、只靠负载字段区分时，用它限定只在特定广播上通知：所列字段的值必须全部与之相等（值限字符串、数字、布尔）。不写则每次广播都通知 |
| `audio.success` | 否   | 完成类通知（含需要你回答/批准的事件通知）的音频文件，缺省 `src/sounds/complete.wav`                                                                            |
| `audio.error`   | 否   | 失败通知的音频文件，缺省 `src/sounds/error.wav`                                                                                                                |

规则：

- 缺 `event` 或 `title` 的条目被丢弃，其余条目照常工作
- `events` 缺失、为空或 JSON 损坏 → 不弹自定义通知，完成/失败通知不受影响
- 配置文件在扩展加载时读一次，改动需重启 pi 或 `/reload`
- 同样受失焦抑制：只有终端失焦时才通知

## 工作原理

- **完成/失败**取自 `agent_settled`，不用 `agent_end`：重试、压缩、排队消息都会在 `agent_end` 之后再启动一次运行，用 `agent_end` 会提前或重复通知。正文读取当前会话分支的最后一条消息。
- **自定义事件**在加载时按配置订阅 `pi.events` 通道，`session_shutdown` 时统一退订。
- **焦点检测**通过 `ctx.ui.setWidget` 拿到真 TUI 后开启 DECSET 1004（`\x1b[?1004h`），在 `process.stdin` 原始层监听 `\x1b[O` / `\x1b[I`。不能用 `ctx.ui.onTerminalInput`：alt-screen 的 viewport 监听器先注册并会 consume 焦点序列。终端不支持 1004 时永远收不到焦点事件，状态保持「聚焦」，即不通知。

## 命令

```bash
pnpm check    # tsc --noEmit && eslint
pnpm test     # vitest run
pnpm format   # prettier --write
```

## 目录

```text
src/index.ts               入口：配置解析 + 事件接线 + agent_settled + 焦点检测
src/sounds/*.wav           afplay 播放的提示音
tests/notify.test.ts       parseConfig、matchesWhen、pickPath、pickText、truncate 的用例
```
