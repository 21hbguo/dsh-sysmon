/**
 * @dsh-external/dsh-sysmon — 系统性能看板 host 半区。
 *
 * Registers the zero-dependency metrics collector and its single JSON route
 * (`GET /api/sysmon/snapshot`) on the DSH web server. The browser half (the
 * `./client` entry) renders a small floating window that polls this endpoint
 * at a low frequency; the collector caches between polls so the host cost is
 * one tiny `/proc` read per `cacheMs` at most.
 * @module @dsh-external/dsh-sysmon
 */

import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import { SysmonCollector } from './metrics.js'
import { makeSysmonRoutes } from './routes.js'

/** Stable cordis plugin name (matches cordis.patch.yml insert id). */
export const name = 'sysmon'

/** Services required before the sysmon surface can mount. */
export const inject = ['webServer']

/** Plugin configuration. */
export interface Config {
  /** Master switch: disables the route while keeping the plugin loaded. */
  enabled?: boolean
  /** Minimum interval between collector recomputes, in milliseconds. */
  cacheMs?: number
}

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  cacheMs: z.number().min(100).max(60_000).step(100).default(2000),
})

/** Settings namespace the sysmon settings card edits. */
export const SYSMON_SETTINGS_NAMESPACE = settingsNamespace('sysmon')

/** Register the sysmon collector and its snapshot route, switched by the settings `enabled` switch. */
export function apply(ctx: Context, config: Config = {}): void {
  // The authoritative source: the settings section once the web settings
  // surface serves it, the composition entry otherwise.
  let current: () => Config = () => config ?? {}
  let disposeRoutes: (() => void) | undefined
  let collector: SysmonCollector | undefined

  const sync = (): void => {
    const enabled = current().enabled ?? true
    if (disposeRoutes === undefined && enabled) {
      const cacheMs = current().cacheMs ?? 2000
      collector = new SysmonCollector(cacheMs)
      disposeRoutes = ctx.effect(
        () => {
          collector?.start()
          const disposers = makeSysmonRoutes({ collector: collector! }).map((route) => ctx.webServer.register(route))
          return () => {
            for (const dispose of disposers) dispose()
            collector?.dispose()
          }
        },
        'sysmon: routes',
      )
    } else if (disposeRoutes !== undefined && !enabled) {
      disposeRoutes()
      disposeRoutes = undefined
      collector = undefined
    }
  }

  installSettingsSection(ctx, SYSMON_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => { current = source },
    onChange: sync,
  }, {
    // 显式声明 web 暴露：设置页卡片可真正读写（无需改 dsh-host-apiproxy 白名单）
    web: true,
  })
  sync()
  ctx.logger?.info?.(`[sysmon] 性能看板已就绪（${current().enabled ?? true ? '启用' : '停用'}，可在设置-插件中开关）`)
}
