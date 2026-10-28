/**
 * node-notifier 没有内置类型，这里只声明本项目用到的那一个方法。
 *
 * 上游是 CJS：module.exports 是 notifier 实例，故用 export =；
 * tsconfig 的 moduleResolution: bundler 隐含 allowSyntheticDefaultImports，默认导入可用。
 */
declare module 'node-notifier' {
  interface NotificationOptions {
    title?: string
    message?: string
    /** 图标路径；node-notifier 会按平台翻译成 -appIcon / -p / -i */
    icon?: string
  }

  interface Notifier {
    notify(
      options: NotificationOptions,
      callback?: (error: Error | null, response?: string) => void
    ): unknown
  }

  const notifier: Notifier
  export = notifier
}
