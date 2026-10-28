import { afterEach, describe, expect, test, vi } from 'vitest'

import { parseConfig } from '../src/config'

// notify 会起子进程或调库；测试里换成桩，只验证分派，不真的发通知
const execFileMock = vi.hoisted(() => vi.fn(() => ({ kill: vi.fn() })))
const notifierMock = vi.hoisted(() => ({ notify: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('node-notifier', () => ({ default: notifierMock }))

import { audioCommand, audioPath, macArgs, notificationChannel, notify } from '../src/desktop'
import { matchesWhen, pickPath, pickText, settledNotice, truncate } from '../src/payload'

describe('parseConfig', () => {
  test('坏 JSON 与非对象根都视为无自定义事件', () => {
    expect(parseConfig('{')).toEqual({ events: [] })
    expect(parseConfig('[]')).toEqual({ events: [] })
    expect(parseConfig('null')).toEqual({ events: [] })
  })

  test('events 缺失或不是数组时为空', () => {
    expect(parseConfig('{}')).toEqual({ events: [] })
    expect(parseConfig('{"events":"x"}')).toEqual({ events: [] })
  })

  test('缺 event 或 title 的条目被丢弃，其余照常解析', () => {
    const config = parseConfig(
      JSON.stringify({
        events: [
          { title: { fallback: '无事件名' } },
          { event: 'a:b' },
          { event: 'a:c', title: { fallback: '有效' } }
        ]
      })
    )
    expect(config.events).toHaveLength(1)
    expect(config.events[0]).toMatchObject({ event: 'a:c', title: { fallback: '有效' } })
  })

  test('title/body 只解析 path 与 fallback，旧写法与非法形态都视为未配置', () => {
    const config = parseConfig(
      JSON.stringify({
        events: [
          { event: 'a', title: { path: 'data.name', fallback: 'A' }, body: { path: 'value' } },
          { event: 'b', title: '固定标题' },
          { event: 'c', title: {}, body: ['value'] },
          { event: 'd', title: { path: 'x' }, body: 'label' }
        ]
      })
    )
    expect(config.events.map((item) => [item.event, item.title, item.body])).toEqual([
      ['a', { path: 'data.name', fallback: 'A' }, { path: 'value', fallback: undefined }],
      ['d', { path: 'x', fallback: undefined }, undefined]
    ])
  })

  test('audio 只保留非空字符串路径，全无效时视为未配置', () => {
    const mixed = parseConfig(JSON.stringify({ audio: { success: '/a.wav', error: '  ' } }))
    expect(mixed.audio).toEqual({ success: '/a.wav', error: undefined })
    expect(parseConfig(JSON.stringify({ audio: { success: '', error: 1 } })).audio).toBeUndefined()
    expect(parseConfig(JSON.stringify({ audio: '/a.wav' })).audio).toBeUndefined()
    expect(parseConfig('{}').audio).toBeUndefined()
  })

  test('when 只保留标量字段，全无效时视为未配置', () => {
    const config = parseConfig(
      JSON.stringify({
        events: [
          {
            event: 'a',
            title: { fallback: 'A' },
            when: { active: true, n: 1, s: 'x', o: { k: 1 } }
          },
          { event: 'b', title: { fallback: 'B' }, when: { o: { k: 1 } } }
        ]
      })
    )
    expect(config.events[0]?.when).toEqual({ active: true, n: 1, s: 'x' })
    expect(config.events[1]?.when).toBeUndefined()
  })
})

describe('matchesWhen', () => {
  test('未配置时一律通过', () => {
    expect(matchesWhen(undefined, undefined)).toBe(true)
    expect(matchesWhen({ active: false }, undefined)).toBe(true)
  })

  test('全部字段严格等值才算通过', () => {
    const when = { active: true }
    expect(matchesWhen({ active: true }, when)).toBe(true)
    expect(matchesWhen({ active: 'true' }, when)).toBe(false)
    expect(matchesWhen({ active: false }, when)).toBe(false)
    expect(matchesWhen(undefined, when)).toBe(false)
    expect(matchesWhen('payload', when)).toBe(false)
  })
})

describe('pickPath', () => {
  test('按点号路径逐层取值', () => {
    expect(pickPath({ data: { label: '需要回答' } }, 'data.label')).toBe('需要回答')
    expect(pickPath({ label: '顶层' }, 'label')).toBe('顶层')
  })

  test('中间层缺失、不是对象、或最终值不是非空字符串时取不到', () => {
    expect(pickPath({}, 'data.label')).toBeUndefined()
    expect(pickPath({ data: 'x' }, 'data.label')).toBeUndefined()
    expect(pickPath({ data: { label: 1 } }, 'data.label')).toBeUndefined()
    expect(pickPath({ data: { label: '  ' } }, 'data.label')).toBeUndefined()
    expect(pickPath(undefined, 'data.label')).toBeUndefined()
  })
})

describe('pickText', () => {
  test('路径命中时优先用命中值', () => {
    const source = { path: 'data.label', fallback: '等待' }
    expect(pickText({ data: { label: '需要回答' } }, source)).toBe('需要回答')
  })

  test('路径未命中时用 fallback，没有 fallback 时为空串', () => {
    expect(pickText({ data: {} }, { path: 'data.label', fallback: '操作' })).toBe('操作')
    expect(pickText(undefined, { path: 'data.label' })).toBe('')
  })

  test('未配置来源时为空串', () => {
    expect(pickText({ label: 'x' }, undefined)).toBe('')
  })
})

describe('audioCommand', () => {
  // 环境变量在用例之间必须复原，否则一个失败会连带影响后面的平台分支
  afterEach(() => vi.unstubAllEnvs())

  test('macOS 用 afplay', () => {
    expect(audioCommand('darwin', '/a.wav', () => false)).toEqual(['afplay', ['/a.wav']])
  })

  test('Windows 用 PowerShell SoundPlayer，路径内单引号翻倍', () => {
    const command = audioCommand('win32', "C:\\it's\\a.wav", () => false)
    expect(command?.[0]).toBe('powershell')
    expect(command?.[1]).toContain("(New-Object Media.SoundPlayer 'C:\\it''s\\a.wav').PlaySync()")
  })

  test('WSL 借 Windows 侧的 powershell.exe', () => {
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
    const command = audioCommand('linux', '/a.wav', () => true)
    expect(command?.[0]).toBe('powershell.exe')
  })

  test('Linux 按 paplay / aplay / ffplay 顺序探测', () => {
    // WSL 也会走 linux 分支，这里显式清空以避免在 WSL 机器上误判
    vi.stubEnv('WSL_DISTRO_NAME', '')

    expect(audioCommand('linux', '/a.wav', (name) => name === 'aplay')).toEqual([
      'aplay',
      ['/a.wav']
    ])
    expect(audioCommand('linux', '/a.wav', (name) => name === 'ffplay')).toEqual([
      'ffplay',
      ['-nodisp', '-autoexit', '-loglevel', 'quiet', '/a.wav']
    ])
    expect(audioCommand('linux', '/a.wav', () => true)).toEqual(['paplay', ['/a.wav']])
    expect(audioCommand('linux', '/a.wav', () => false)).toBeUndefined()
  })
})

describe('audioPath', () => {
  test('配置未指定音频时回退内置提示音', () => {
    expect(audioPath({ events: [] }, 'success')).toMatch(/sounds\/complete\.wav$/)
    expect(audioPath({ events: [] }, 'error')).toMatch(/sounds\/error\.wav$/)
  })

  test('配置的音频文件不存在时同样回退内置', () => {
    const config = { events: [], audio: { success: '/definitely/missing.wav' } }
    expect(audioPath(config, 'success')).toMatch(/sounds\/complete\.wav$/)
  })
})

describe('macArgs', () => {
  test('等人响应时带 -json 与长超时，没有输入框时不传 -reply', () => {
    const args = macArgs({ title: 'T', body: 'B' })
    expect(args).toContain('-json')
    expect(args[args.indexOf('-timeout') + 1]).toBe('600')
    expect(args).not.toContain('-reply')
  })

  test('发完即走的通知不带 -json，超时缩短到 10 秒', () => {
    const args = macArgs({ title: 'T', body: 'B' }, false)
    expect(args).not.toContain('-json')
    expect(args[args.indexOf('-timeout') + 1]).toBe('10')
  })

  test('有输入框时传占位文字', () => {
    const args = macArgs({ title: 'T', body: 'B', reply: '输入指令' })
    expect(args[args.indexOf('-reply') + 1]).toBe('输入指令')
  })
})

describe('notify', () => {
  afterEach(() => vi.clearAllMocks())

  test('darwin 直连二进制，不走 node-notifier，也不传已失效的 -appIcon', () => {
    notify('T', 'B', 'darwin')
    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [bin, args] = execFileMock.mock.calls[0] as unknown as [string, string[]]
    expect(bin).toMatch(/terminal-notifier$/)
    expect(args).not.toContain('-appIcon')
    expect(args).toEqual(expect.arrayContaining(['-timeout', '10']))
    expect(notifierMock.notify).not.toHaveBeenCalled()
  })

  test('Windows / Linux 把图标交给 node-notifier', () => {
    notify('T', 'B', 'win32')
    expect(notifierMock.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'T',
        message: 'B',
        icon: expect.stringMatching(/assets[\\/]pi\.png$/)
      }),
      expect.any(Function)
    )
    expect(execFileMock).not.toHaveBeenCalled()
  })
})

describe('notificationChannel', () => {
  test('按平台与 WSL 选实现', () => {
    expect(notificationChannel('darwin', false)).toBe('mac')
    expect(notificationChannel('win32', false)).toBe('windows')
    expect(notificationChannel('linux', true)).toBe('windows')
    expect(notificationChannel('linux', false)).toBe('linux')
  })
})

describe('settledNotice', () => {
  test('完成与失败各有标题与占位文字，正文按码点截断', () => {
    expect(settledNotice(false, undefined, '做完了')).toEqual({
      title: '✅ Task Complete',
      body: '做完了',
      reply: '输入下一步指令'
    })
    expect(settledNotice(true, '连接超时', '')).toEqual({
      title: '❌ Task Failed',
      body: '连接超时',
      reply: '输入指令继续'
    })
  })

  test('正文为空字符串时回退到兜底文案', () => {
    expect(settledNotice(true, '', '').body).toBe('任务失败')
    expect(settledNotice(false, undefined, '').body).toBe('任务已完成')
  })
})

describe('truncate', () => {
  test('超过 120 字符截断并加省略号', () => {
    expect(truncate('a'.repeat(120))).toHaveLength(120)
    expect(truncate('a'.repeat(121))).toHaveLength(120)
    expect(truncate('a'.repeat(121)).endsWith('…')).toBe(true)
  })

  test('按码点切，不把 emoji 切一半', () => {
    expect(truncate('😀'.repeat(121))).toBe('😀'.repeat(119) + '…')
  })
})
