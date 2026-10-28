/**
 * 事件负载：过滤与取值。
 *
 * 标题与正文都是「点号属性路径 + fallback」，逐层取值；长文本按码点截断。
 * 只依赖 config 的类型，运行时不反向依赖 config。
 */

import type { EventRule, TextSource } from './config'

/** 非空字符串判定：配置校验与负载取值共用的唯一实现。 */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 通知正文截断长度，完成通知与自定义事件共用。 */
const BODY_LIMIT = 120

/** 负载字段严格等值过滤；未配置 when 时一律通过。 */
export function matchesWhen(data: unknown, when: EventRule['when']): boolean {
  if (!when) return true
  if (!data || typeof data !== 'object') return false
  const payload = data as Record<string, unknown>
  return Object.entries(when).every(([key, expected]) => payload[key] === expected)
}

/** 按点号路径逐层取值；中间层不是对象或最终值不是非空字符串时返回 undefined。 */
export function pickPath(data: unknown, path: string): string | undefined {
  let current: unknown = data
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return nonEmptyString(current)
}

/** 取文本来源的值：路径命中就用命中值，否则用 fallback（可能为空字符串）。 */
export function pickText(data: unknown, source: TextSource | undefined): string {
  if (!source) return ''
  const value = source.path ? pickPath(data, source.path) : undefined
  return value ?? source.fallback ?? ''
}

/** 截断长文本，避免通知被系统裁切；按码点切，不把 emoji 切成孤立代理项。 */
export function truncate(text: string): string {
  // Array.from 按码点拆分，slice 后再拼回去
  const chars = Array.from(text)
  return chars.length > BODY_LIMIT ? chars.slice(0, BODY_LIMIT - 1).join('') + '…' : text
}
