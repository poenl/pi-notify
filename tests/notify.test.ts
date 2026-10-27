import { describe, expect, test } from 'vitest'

import {
  escapeAppleScript,
  matchesWhen,
  parseConfig,
  pickPath,
  pickText,
  truncate
} from '../src/index'

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

describe('escapeAppleScript', () => {
  test('反斜杠与双引号被转义，构造串无法闭合字符串字面量', () => {
    expect(escapeAppleScript('a\\b')).toBe('a\\\\b')
    expect(escapeAppleScript('say "hi"')).toBe('say \\"hi\\"')
    // 转义后引号变成 \"，AppleScript 不会把它当成字符串结尾
    expect(escapeAppleScript('" & do shell script "x')).toBe('\\" & do shell script \\"x')
  })

  test('回车与换行换成空格，不破坏单行字面量', () => {
    expect(escapeAppleScript('a\r\nb')).toBe('a  b')
    expect(escapeAppleScript('a\nb')).toBe('a b')
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
