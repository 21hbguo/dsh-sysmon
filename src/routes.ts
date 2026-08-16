/**
 * dsh-sysmon HTTP routes — the browser half polls a single same-origin JSON
 * endpoint for the live snapshot. One tiny surface keeps the footprint low:
 * no SSE, no WebSocket, just `GET /api/sysmon/snapshot` answered from the
 * collector cache.
 * @module @dsh-external/dsh-sysmon/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SysmonCollector } from './metrics.js'

/** Browser-facing base path of the sysmon API. */
export const SYSMON_API_PREFIX = '/api/sysmon'

/** Write one JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Build the full route family for one collector. */
export function makeSysmonRoutes(deps: { collector: SysmonCollector }): WebRoute[] {
  const { collector } = deps
  return [
    {
      kind: 'exact',
      path: `${SYSMON_API_PREFIX}/snapshot`,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        json(res, 200, collector.snapshot())
      },
    },
  ]
}
