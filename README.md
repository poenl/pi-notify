**English** | [简体中文](README.zh-CN.md)

# pi-notify

A pi extension: posts system notifications on macOS, Windows and Linux when a task finishes or fails, and when another extension is waiting for your input.

## What you get

| When                          | Notification                                      | Sound   |
| ----------------------------- | ------------------------------------------------- | ------- |
| the turn settles successfully | ✅ Task Complete — last assistant text, truncated | success |
| the turn fails                | ❌ Task Failed — error message                    | error   |

Notifications fire **only while the terminal window is unfocused**. If you are looking at the terminal, nothing pops up.

On macOS those two notifications also carry a text field: what you type there is sent to the agent as the next user message. Windows and Linux do not support this.

Terminals that do not report focus (DECSET 1004) never say whether they are focused, so there every finished turn notifies. That covers macOS Terminal.app, `screen`, and tmux without `set -g focus-events on`.

## Install

From the git repository:

```bash
pi install git:github.com/poenl/pi-notify
```

Try it for a single invocation (current process only, nothing written to settings):

```bash
pi -e git:github.com/poenl/pi-notify
```

Requires Node `^22.22.2 || ^24.15.0 || >=26.0.0` (the range `node-notifier` needs). Notifications go through `node-notifier`: `terminal-notifier` on macOS, `snoretoast` on Windows and WSL, `notify-send` on Linux (install `libnotify`). Sounds play through `afplay` on macOS, PowerShell `SoundPlayer` on Windows and WSL, and the first available of `paplay` / `aplay` / `ffplay` on Linux.

The macOS notifier binary shipped by `node-notifier` is x86_64 only, so Apple Silicon needs Rosetta 2 installed.

On macOS, allow `terminal-notifier` and pick Banners in System Settings → Notifications, otherwise nothing pops up. Reinstalling dependencies may need re-approval.

## Notify on other extensions' events

Any `pi.events` channel can be mapped to a notification in the config file. No code change needed.

Config file: `~/.pi/agent/extensions/pi-notify/config.json`.

```json
{
  "audio": {
    "success": "/Users/you/ok.wav",
    "error": "/Users/you/fail.wav"
  },
  "events": [
    {
      "event": "example-ext:needs-input",
      "title": { "path": "data.name", "fallback": "❓ Needs your answer" },
      "body": { "path": "data.message", "fallback": "Waiting for your input" },
      "when": { "active": true }
    },
    {
      "event": "example-ext:needs-approval",
      "title": { "fallback": "🔐 Needs your approval" },
      "body": { "path": "data.detail", "fallback": "operation" }
    }
  ]
}
```

| Field           | Required | Meaning                                                                                                                                                                                                                                     |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event`         | yes      | `pi.events` channel name                                                                                                                                                                                                                    |
| `title`         | yes      | title source: `path` is a dotted property path resolved level by level, `fallback` is used when it misses; a rule with neither is dropped                                                                                                   |
| `body`          | no       | body source, same shape as `title`; the body falls back to the title when it misses                                                                                                                                                         |
| `when`          | no       | for channels that carry several cases told apart only by payload fields: notify only on the matching broadcasts, i.e. every listed field must equal the given value exactly (strings, numbers, booleans). Omitted, every broadcast notifies |
| `audio.success` | no       | audio file for completion-class notifications (including needs-answer / needs-approval events), defaults to `src/sounds/complete.wav`                                                                                                       |
| `audio.error`   | no       | audio file for failure notifications, defaults to `src/sounds/error.wav`                                                                                                                                                                    |

Rules:

- an entry missing `event` or `title` is dropped; other entries keep working
- `events` missing, empty, or broken JSON → no custom notifications, the finish/failure notifications still work
- the file is read once, when the extension loads, so a change needs a pi restart or `/reload`
- the same unfocus rule applies: notifications appear only while the terminal is unfocused

## How it works

- **Finish / failure** comes from `agent_settled`, not `agent_end`: retries, compaction and queued messages can start another run after `agent_end`, which would notify too early or twice. The body is read from the last message on the current session branch.
- **Replying from the notification** works on macOS only. Only the newest notification waits at a time, and `session_shutdown` kills whatever is still pending. Windows and Linux only get a plain notification and never return text.
- **Custom events** subscribe to the configured `pi.events` channels at load time and unsubscribe on `session_shutdown`.
- **Focus detection** enables DECSET 1004 (`\x1b[?1004h`) through the real TUI obtained from `ctx.ui.setWidget`, and listens for `\x1b[O` / `\x1b[I` on raw `process.stdin`. `ctx.ui.onTerminalInput` cannot be used: the alt-screen viewport listener registers first and consumes focus sequences. Terminals without 1004 support never report focus, so the state stays "unfocused" and every turn notifies.

## Commands

```bash
pnpm check    # tsc --noEmit && eslint
pnpm test     # vitest run
pnpm format   # prettier --write
```

## Layout

```text
src/index.ts               entry: event wiring + agent_settled + session lifecycle
src/config.ts              config types + parseConfig / loadConfig
src/payload.ts             matchesWhen / pickPath / pickText / truncate / settledNotice
src/desktop.ts             notify / askNotify / macArgs / audioCommand / playAudio / audioPath
src/focus.ts               DECSET 1004 focus detection
src/sounds/*.wav           notification sounds
tests/notify.test.ts       cases for parseConfig, matchesWhen, pickPath, pickText, settledNotice, truncate, macArgs, audioCommand and audioPath
```
