/**
 * @dsh-external/dsh-sysmon — 浏览器半区：小悬浮窗 + 设置卡片。
 *
 * Mounts a compact always-on-top floating window on `document.body` (host
 * global, no session dimension — it stays visible on the new-conversation
 * screen, same as dsh-pet) plus a small `settings.plugin.item` card in the
 * plugin-configuration section. Polls `GET /api/sysmon/snapshot` every
 * {@link POLL_MS}; the poll pauses while the tab is hidden so a background
 * tab burns zero RPCs. All rendering is plain DOM + one injected <style>
 * block — no react, no UI framework, no css-module: the whole client bundle
 * is a few KB and the per-tick cost is one JSON fetch.
 *
 * Failure policy: DOM/transport problems are logged and swallowed, never
 * thrown — the web shell fails the whole boot when a plugin apply throws.
 *
 * Interactions: drag anywhere on the title bar (position persisted to
 * localStorage), click the title to collapse to a one-line CPU strip, click
 * the × to hide (a summon button reappears bottom-right); hovering the
 * ↓下载 / ↑上传 rows shows a per-process network TOP10 tooltip.
 * @module @dsh-external/dsh-sysmon/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the slots SlotMap merge table for the settings card seat.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings-surface Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SysmonSnapshot } from '../types.js'
import { SysmonSettingsCard, SysmonSettingsCardController, type SysmonSettings } from './SysmonSettingsCard.js'
import { zh, en, type SysmonLocaleKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** sysmon settings-card copy. */
    'sysmon': SysmonLocaleKey
  }

  interface SlotMap {
    /** The official plugin-card seat this package registers into. */
    'settings.plugin.item': { kind: 'list'; scope: 'root'; owner: SysmonCardOwnerProps }
  }
}

/** Owner share of the sysmon card (the section supplies nothing). */
export interface SysmonCardOwnerProps {
  /** Marker field: card owner props are intentionally empty. */
  children?: never
}

/** Poll interval (ms) while the tab is visible. */
const POLL_MS = 2000

/** localStorage key for the widget position + visibility. */
const LS_KEY = 'dsh.sysmon.ui.v1'

/** Default widget position (px from the viewport right/bottom edges). */
const DEFAULT_RIGHT = 16
const DEFAULT_BOTTOM = 20

/** One rendered metric row: label, value text, percent bar (0-100 or null). */
interface MetricRow {
  /** Group heading this row belongs under (计算 / 存储 / 网络). */
  group: string
  label: string
  value: string
  percent: number | null
  /** Hover tooltip explaining the row's numbers (optional). */
  title?: string
  /** Fixed bar color (overrides the percent-based color); used to tell the
   *  network direction bars apart at a glance (下载蓝 / 上传橙). */
  barColor?: string
  /** Marks the download/upload rate rows: hovering them shows the per-process
   *  TOP10 network tooltip for the given direction. */
  netDir?: 'down' | 'up'
}

/** Decay factor per poll tick for the network-bar scale (bytes/s): the scale
 *  snaps up to the current peak instantly and decays slowly, so the rate bars
 *  stay proportional to the *recent* peak instead of a fixed cap. */
const NET_SCALE_DECAY = 0.9

/** Persisted widget placement. */
interface WidgetState {
  right: number
  bottom: number
  visible: boolean
  collapsed: boolean
}

/** Widget styles, injected once into <head>. */
const WIDGET_CSS = `
.sysmon-widget {
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #e6e6e6;
  background: rgba(17, 17, 20, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 6px 8px;
  min-width: 168px;
  max-width: 240px;
  user-select: none;
  cursor: default;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.sysmon-title {
  font-size: 11px;
  font-weight: 600;
  color: #9ad0ff;
  cursor: grab;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-bottom: 3px;
  margin-bottom: 3px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  touch-action: none;
}
.sysmon-title:active { cursor: grabbing; }
.sysmon-close {
  color: #999;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  flex: none;
}
.sysmon-close:hover { color: #ff6b6b; }
.sysmon-body { display: block; }
.sysmon-group {
  font-size: 10px;
  font-weight: 600;
  color: #7d8790;
  letter-spacing: 0.04em;
  padding: 3px 0 1px;
  margin-top: 2px;
}
.sysmon-group:first-child { margin-top: 0; padding-top: 0; }
.sysmon-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 0;
  white-space: nowrap;
}
.sysmon-row-label {
  flex: none;
  width: 44px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #9ba1a6;
}
.sysmon-row-value {
  flex: none;
  color: #f0f0f0;
  width: 92px;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sysmon-bar-wrap {
  flex: none;
  width: 64px;
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
  display: block;
}
.sysmon-bar {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s ease;
}
.sysmon-tooltip {
  position: fixed;
  z-index: 2147483647;
  font: 11px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #e6e6e6;
  background: rgba(17, 17, 20, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  padding: 6px 8px;
  min-width: 210px;
  max-width: 280px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  white-space: nowrap;
}
.sysmon-tooltip-header {
  font-size: 10px;
  font-weight: 600;
  color: #7d8790;
  letter-spacing: 0.04em;
  padding-bottom: 3px;
  margin-bottom: 3px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.sysmon-tooltip-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.sysmon-tooltip-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #9ba1a6;
}
.sysmon-tooltip-rate {
  width: 66px;
  text-align: right;
  flex: none;
}
.sysmon-tooltip-rx { color: #4f8cff; }
.sysmon-tooltip-tx { color: #f5a524; }
.sysmon-tooltip-conns { color: #9ad0ff; }
.sysmon-tooltip-empty {
  color: #7d8790;
  padding: 2px 0;
}
.sysmon-summon {
  position: fixed;
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #9ad0ff;
  background: rgba(17, 17, 20, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 4px 8px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.sysmon-summon:hover { color: #fff; }
`

/** Read persisted state, clamping to sane bounds. */
function loadState(): WidgetState {
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<WidgetState>
      return {
        right: typeof parsed.right === 'number' ? parsed.right : DEFAULT_RIGHT,
        bottom: typeof parsed.bottom === 'number' ? parsed.bottom : DEFAULT_BOTTOM,
        visible: parsed.visible !== false,
        collapsed: parsed.collapsed === true,
      }
    }
  } catch {
    // localStorage unavailable (private mode); fall through to defaults.
  }
  return { right: DEFAULT_RIGHT, bottom: DEFAULT_BOTTOM, visible: true, collapsed: false }
}

/** Persist widget placement (best-effort). */
function saveState(state: WidgetState): void {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(state))
  } catch {
    // Best-effort only.
  }
}

/** Inject the widget styles once. */
function ensureStyles(): void {
  if (document.getElementById('dsh-sysmon-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-sysmon-style'
  style.textContent = WIDGET_CSS
  document.head.appendChild(style)
}

/** Format a byte count compactly (B / KB / MB / GB). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

/** Compact byte format for narrow rows: `7.8G`, `412G`, `1.8T`. */
function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  const units = ['B', 'K', 'M', 'G', 'T']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10}${units[unit]}`
}

/** Format a rate per second. */
function formatRate(bytesPerSec: number | null): string {
  if (bytesPerSec === null) return '--'
  return `${formatBytes(bytesPerSec)}/s`
}

/** Network bar percent: current rate relative to the widget's decaying peak
 *  scale, clamped to 0-100 (null when the rate or the scale is unavailable). */
function ratePercent(rate: number | null, scale: number): number | null {
  if (rate === null || scale <= 0) return null
  return Math.round(Math.min(100, Math.max(0, (rate / scale) * 100)) * 10) / 10
}

/** Format seconds as d h m. */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

/** Build the metric rows for one snapshot. `netScale` (bytes/s) drives the
 *  network rate bars — see {@link NET_SCALE_DECAY}. */
function rowsOf(s: SysmonSnapshot, netScale: number): MetricRow[] {
  const cpu: MetricRow = {
    group: '计算',
    label: 'CPU',
    value: s.cpu === null ? '--' : `${s.cpu}%`,
    percent: s.cpu,
    title: 'CPU 使用率（近 2 秒均值）',
  }
  const mem: MetricRow = {
    group: '计算',
    label: 'MEM',
    value: `${formatBytesShort(s.mem.used)}/${formatBytesShort(s.mem.total)}`,
    percent: s.memPercent,
    title: `内存使用率 ${s.memPercent}% · 已用 ${formatBytes(s.mem.used)} / 共 ${formatBytes(s.mem.total)}`,
  }
  // One row per physical disk mount (root first, then by used bytes).
  const disks: MetricRow[] = s.disks.length === 0
    ? [{ group: '存储', label: 'DSK', value: '--', percent: null, title: '磁盘信息不可用' }]
    : s.disks.map((d) => ({
        group: '存储',
        label: d.mount,
        value: `${formatBytesShort(d.used)}/${formatBytesShort(d.total)}`,
        percent: d.percent,
        title: `${d.mount} 使用率 ${d.percent}% · 已用 ${formatBytes(d.used)} / 共 ${formatBytes(d.total)}`,
      }))
  // Download / upload as two separate rate rows, each with its own bar
  // (percent = rate / recent-peak scale; color tells the direction apart).
  const down: MetricRow = {
    group: '网络',
    label: '↓下载',
    value: formatRate(s.netRxRate),
    percent: ratePercent(s.netRxRate, netScale),
    barColor: '#4f8cff',
    netDir: 'down',
    title: `下行速率（接收）${formatRate(s.netRxRate)}`,
  }
  const up: MetricRow = {
    group: '网络',
    label: '↑上传',
    value: formatRate(s.netTxRate),
    percent: ratePercent(s.netTxRate, netScale),
    barColor: '#f5a524',
    netDir: 'up',
    title: `上行速率（发送）${formatRate(s.netTxRate)}`,
  }
  const gpu: MetricRow | null = s.gpuPercent === null && s.gpuMem === null
    ? null
    : {
        group: '计算',
        label: 'GPU',
        value: s.gpuPercent === null
          ? `VRAM ${formatBytesShort(s.gpuMem?.used ?? 0)}/${formatBytesShort(s.gpuMem?.total ?? 0)}`
          : s.gpuMem === null ? '--' : `${formatBytesShort(s.gpuMem.used)}/${formatBytesShort(s.gpuMem.total)}`,
        percent: s.gpuPercent,
        title: s.gpuPercent === null
          ? `显存 已用 ${s.gpuMem === null ? '--' : formatBytes(s.gpuMem.used)} / 共 ${s.gpuMem === null ? '--' : formatBytes(s.gpuMem.total)}`
          : `GPU 使用率 ${s.gpuPercent}% · 显存 已用 ${s.gpuMem === null ? '--' : formatBytes(s.gpuMem.used)} / 共 ${s.gpuMem === null ? '--' : formatBytes(s.gpuMem.total)}`,
      }
  // 分组顺序：计算 → 存储 → 网络；每组内部保持原相对顺序。
  const groups: MetricRow[] = []
  for (const row of [cpu, gpu, mem, ...disks, down, up]) {
    if (row === null) continue
    groups.push(row)
  }
  return groups
}

/** The floating widget — owns its DOM subtree and the poll timer. */
class SysmonWidget {
  private readonly state: WidgetState
  private readonly root: HTMLDivElement
  private readonly titleBarEl: HTMLDivElement
  private readonly titleTextEl: HTMLSpanElement
  private readonly bodyEl: HTMLDivElement
  private readonly rowsEl: HTMLDivElement
  private timer: number | undefined
  /** True while a snapshot fetch is in flight (skips overlapping polls). */
  private fetching = false
  private dragging = false
  /** Movement threshold (px) distinguishing a drag from a click on the title. */
  private dragMoved = false
  /** Suppress the click that the browser fires right after a real drag. */
  private suppressClick = false
  private dragPointerId = 0
  private dragStartX = 0
  private dragStartY = 0
  private dragStartRight = 0
  private dragStartBottom = 0
  private summonEl: HTMLButtonElement | null = null
  private visibilityCleanup: (() => void) | null = null
  /** Decaying network-rate scale (bytes/s) the rate bars are drawn against. */
  private netScale = 0
  /** Last rendered snapshot (drives the per-process TOP10 hover tooltip). */
  private lastSnapshot: SysmonSnapshot | null = null
  /** Network direction row currently hovered (null = tooltip hidden). */
  private hoveredNet: 'down' | 'up' | null = null
  private tooltipEl: HTMLDivElement | null = null

  constructor() {
    this.state = loadState()
    this.root = document.createElement('div')
    this.root.className = 'sysmon-widget'
    this.root.style.position = 'fixed'
    this.root.style.right = `${this.state.right}px`
    this.root.style.bottom = `${this.state.bottom}px`
    this.root.style.zIndex = '2147483647'

    this.titleTextEl = document.createElement('span')
    this.titleTextEl.className = 'sysmon-title-text'
    this.titleTextEl.textContent = '性能'

    const closeBtn = document.createElement('span')
    closeBtn.className = 'sysmon-close'
    closeBtn.textContent = '×'
    closeBtn.title = '隐藏悬浮窗'
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.hide()
    })

    this.titleBarEl = document.createElement('div')
    this.titleBarEl.className = 'sysmon-title'
    this.titleBarEl.title = '数字含义：负载（1/5/15 分钟均值）· 系统运行时长\n点击折叠/展开 · 拖动移动'
    this.titleBarEl.appendChild(this.titleTextEl)
    this.titleBarEl.appendChild(closeBtn)
    // Pointer capture must be taken on the title bar itself: per the Pointer
    // Events spec, the click that follows a captured pointerup is dispatched
    // to the CAPTURE target — capturing on `root` would swallow the toggle
    // click and collapse/expand would never fire.
    this.titleBarEl.addEventListener('pointerdown', (e) => this.beginDrag(e))
    this.titleBarEl.addEventListener('click', (e) => {
      if (e.target === closeBtn) return
      if (this.suppressClick) {
        // The browser fired this click right after a real drag; swallow it so
        // a drag never toggles the collapse state.
        this.suppressClick = false
        return
      }
      this.state.collapsed = !this.state.collapsed
      saveState(this.state)
      this.renderCollapse()
    })

    this.rowsEl = document.createElement('div')
    this.rowsEl.className = 'sysmon-rows'

    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'sysmon-body'
    this.bodyEl.appendChild(this.rowsEl)

    this.root.appendChild(this.titleBarEl)
    this.root.appendChild(this.bodyEl)
  }

  /** Apply the collapsed/expanded visual state (explicit inline styles so the
   *  stylesheet `display:none` defaults never fight the toggled state).
   *  Collapsed = title line only; the metric rows are hidden entirely. */
  private renderCollapse(): void {
    this.bodyEl.style.display = this.state.collapsed ? 'none' : 'block'
  }

  /** Mount into the DOM and start polling (only while visible). */
  mount(): void {
    ensureStyles()
    if (this.state.visible) {
      document.body.appendChild(this.root)
    }
    this.renderCollapse()
    this.renderSummon()
    this.poll()
    this.start()
  }

  /** Remove from the DOM and stop the timer. */
  dispose(): void {
    this.stop()
    this.hideNetTooltip()
    this.root.remove()
    if (this.summonEl !== null) {
      this.summonEl.remove()
      this.summonEl = null
    }
  }

  /** Begin a drag: capture the pointer and move with it. */
  private beginDrag(e: PointerEvent): void {
    if (e.target instanceof Element && e.target.classList.contains('sysmon-close')) return
    this.dragging = true
    this.dragMoved = false
    this.dragPointerId = e.pointerId
    this.dragStartX = e.clientX
    this.dragStartY = e.clientY
    this.dragStartRight = this.state.right
    this.dragStartBottom = this.state.bottom
    try {
      // Capture on the title bar (see constructor comment): the post-capture
      // click must land on the element whose listener toggles collapse.
      this.titleBarEl.setPointerCapture(e.pointerId)
    } catch {
      // Pointer capture is best-effort; window listeners still track the move.
    }
    window.addEventListener('pointermove', this.onDragMove)
    window.addEventListener('pointerup', this.onDragEnd, { once: true })
    window.addEventListener('pointercancel', this.onDragEnd, { once: true })
  }

  private readonly onDragMove = (e: PointerEvent): void => {
    if (!this.dragging || e.pointerId !== this.dragPointerId) return
    const dx = e.clientX - this.dragStartX
    const dy = e.clientY - this.dragStartY
    if (Math.abs(dx) + Math.abs(dy) > 4) this.dragMoved = true
    const right = Math.max(0, this.dragStartRight - dx)
    const bottom = Math.max(0, this.dragStartBottom - dy)
    this.state.right = Math.round(right)
    this.state.bottom = Math.round(bottom)
    this.root.style.right = `${this.state.right}px`
    this.root.style.bottom = `${this.state.bottom}px`
  }

  private readonly onDragEnd = (): void => {
    if (!this.dragging) return
    this.dragging = false
    window.removeEventListener('pointermove', this.onDragMove)
    // A real drag must not toggle collapse via the follow-up click; a click
    // without movement (dragMoved false) is left alone.
    if (this.dragMoved) this.suppressClick = true
    saveState(this.state)
  }

  /** One poll cycle: fetch the snapshot and render (skips hidden/overlapping). */
  private poll(): void {
    if (!this.state.visible || this.fetching) return
    this.fetching = true
    void fetch('/api/sysmon/snapshot', { cache: 'no-store', signal: AbortSignal.timeout(8000) })
      .then((res) => {
        if (!res.ok) throw new Error(`snapshot ${res.status}`)
        return res.json() as Promise<SysmonSnapshot>
      }).then((snapshot) => {
        this.render(snapshot)
      }).catch((error: unknown) => {
        // A timeout (host busy) keeps the last rendered frame; transport
        // errors (host restarting, route not yet registered) show the offline
        // placeholder and retry on the next tick.
        if (error instanceof DOMException && error.name === 'AbortError') return
        this.renderOffline()
        console.warn('[sysmon] snapshot fetch failed:', error)
      }).finally(() => {
        this.fetching = false
      })
  }

  /** Render a live snapshot into the rows, grouped with headings. */
  private render(s: SysmonSnapshot): void {
    // Update the network-bar scale: snap up to this tick's peak, decay slowly
    // so the bars shrink as traffic drops (relative-to-recent-peak display).
    const peak = Math.max(s.netRxRate ?? 0, s.netTxRate ?? 0)
    this.netScale = Math.max(peak, this.netScale * NET_SCALE_DECAY)
    this.lastSnapshot = s
    const rows = rowsOf(s, this.netScale)
    this.rowsEl.textContent = ''
    let lastGroup: string | undefined
    for (const row of rows) {
      if (row.group !== lastGroup) {
        const heading = document.createElement('div')
        heading.className = 'sysmon-group'
        heading.textContent = row.group
        this.rowsEl.appendChild(heading)
        lastGroup = row.group
      }
      this.rowsEl.appendChild(this.rowEl(row))
    }

    // Title line carries load averages + uptime; hover explains the numbers.
    const loadText = s.load.map((v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0)).join(' / ')
    this.titleTextEl.textContent = `性能 · ${loadText} · ${formatUptime(s.uptime)}`

    // The rows were just rebuilt — re-anchor a still-open TOP10 tooltip.
    this.refreshNetTooltip()
  }

  /** Render the offline placeholder (keeps the widget alive across restarts). */
  private renderOffline(): void {
    this.rowsEl.textContent = ''
    const row = document.createElement('div')
    row.className = 'sysmon-row'
    const label = document.createElement('span')
    label.className = 'sysmon-row-label'
    label.textContent = '--'
    const value = document.createElement('span')
    value.className = 'sysmon-row-value'
    value.textContent = 'offline'
    row.appendChild(label)
    row.appendChild(value)
    this.rowsEl.appendChild(row)
  }

  /** Build one metric row DOM node. */
  private rowEl(row: MetricRow): HTMLElement {
    const line = document.createElement('div')
    line.className = 'sysmon-row'

    const label = document.createElement('span')
    label.className = 'sysmon-row-label'
    label.textContent = row.label

    const value = document.createElement('span')
    value.className = 'sysmon-row-value'
    value.textContent = row.value
    if (row.title !== undefined) value.title = row.title
    if (row.value === '') value.style.display = 'none'

    const barWrap = document.createElement('span')
    barWrap.className = 'sysmon-bar-wrap'
    if (row.percent !== null) {
      const bar = document.createElement('span')
      bar.className = 'sysmon-bar'
      const pct = Math.max(0, Math.min(100, row.percent))
      bar.style.width = `${pct}%`
      bar.style.background = row.barColor ?? (pct >= 90 ? '#e5484d' : pct >= 70 ? '#f5a524' : '#30a46c')
      barWrap.appendChild(bar)
    }

    line.appendChild(label)
    line.appendChild(value)
    line.appendChild(barWrap)

    // Network rate rows get the per-process TOP10 hover tooltip.
    if (row.netDir !== undefined) {
      line.classList.add(`sysmon-row-net-${row.netDir}`)
      line.addEventListener('mouseenter', () => {
        this.hoveredNet = row.netDir!
        this.showNetTooltip()
      })
      line.addEventListener('mouseleave', () => {
        this.hoveredNet = null
        this.hideNetTooltip()
      })
    }
    return line
  }

  /** Show the per-process TOP10 tooltip anchored to the hovered rate row. */
  private showNetTooltip(): void {
    if (this.tooltipEl !== null) return
    const el = document.createElement('div')
    el.className = 'sysmon-tooltip'
    document.body.appendChild(el)
    this.tooltipEl = el
    this.refreshNetTooltip()
  }

  /** Remove the TOP10 tooltip (if open). */
  private hideNetTooltip(): void {
    if (this.tooltipEl !== null) {
      this.tooltipEl.remove()
      this.tooltipEl = null
    }
  }

  /** Rebuild + reposition the open TOP10 tooltip from the latest snapshot. */
  private refreshNetTooltip(): void {
    if (this.hoveredNet === null || this.tooltipEl === null) return
    const el = this.tooltipEl
    el.textContent = ''

    const s = this.lastSnapshot
    const mode = s?.netTopMode ?? 'rate'
    const header = document.createElement('div')
    header.className = 'sysmon-tooltip-header'
    if (mode === 'rate') {
      header.textContent = this.hoveredNet === 'down' ? '进程网络 TOP10 · 下行 ↓' : '进程网络 TOP10 · 上行 ↑'
      header.title = '近 3s 均值 · 仅 TCP · 同用户进程（ss -tinp 采样）'
    } else {
      header.textContent = '进程网络 TOP10 · 活跃连接'
      header.title = '本机 ss 无字节计数 · 按活跃 TCP 连接数排序 · 同用户进程'
    }
    el.appendChild(header)

    const top = s?.netTop ?? []
    if (top.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'sysmon-tooltip-empty'
      empty.textContent = mode === 'rate' ? '暂无进程流量（空闲或数据不足）' : '暂无可见 TCP 连接'
      el.appendChild(empty)
    } else if (mode === 'rate') {
      const dir = this.hoveredNet
      for (const p of top) {
        const row = document.createElement('div')
        row.className = 'sysmon-tooltip-row'
        const name = document.createElement('span')
        name.className = 'sysmon-tooltip-name'
        name.textContent = p.name
        name.title = `pid ${p.pid} · 连接 ${p.conns} · 队列 ${formatBytes(p.queue)}`
        const rx = document.createElement('span')
        rx.className = 'sysmon-tooltip-rate sysmon-tooltip-rx'
        rx.textContent = `↓${formatBytesShort(p.rxRate)}/s`
        const tx = document.createElement('span')
        tx.className = 'sysmon-tooltip-rate sysmon-tooltip-tx'
        tx.textContent = `↑${formatBytesShort(p.txRate)}/s`
        // Emphasize the hovered direction's rate.
        if (dir === 'down') rx.style.fontWeight = '700'
        else tx.style.fontWeight = '700'
        row.appendChild(name)
        row.appendChild(rx)
        row.appendChild(tx)
        el.appendChild(row)
      }
    } else {
      // Connections mode: rank by active sockets, show the connection count.
      for (const p of top) {
        const row = document.createElement('div')
        row.className = 'sysmon-tooltip-row'
        const name = document.createElement('span')
        name.className = 'sysmon-tooltip-name'
        name.textContent = p.name
        name.title = `pid ${p.pid} · 队列 ${formatBytes(p.queue)}`
        const conns = document.createElement('span')
        conns.className = 'sysmon-tooltip-rate sysmon-tooltip-conns'
        conns.textContent = `${p.conns} 连接`
        row.appendChild(name)
        row.appendChild(conns)
        el.appendChild(row)
      }
    }
    this.positionNetTooltip()
  }

  /** Anchor the tooltip just left of the hovered rate row (clamped to viewport). */
  private positionNetTooltip(): void {
    const el = this.tooltipEl
    if (el === null || this.hoveredNet === null) return
    const anchor = this.rowsEl.querySelector<HTMLElement>(`.sysmon-row-net-${this.hoveredNet}`)
    if (anchor === null) return
    const rect = anchor.getBoundingClientRect()
    const tw = el.offsetWidth
    const th = el.offsetHeight
    let left = rect.left - tw - 8
    if (left < 8) left = Math.min(rect.right + 8, Math.max(8, window.innerWidth - tw - 8))
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - th - 8))
    el.style.left = `${Math.round(left)}px`
    el.style.top = `${Math.round(top)}px`
  }

  /** Toggle the summon button according to visibility. */
  private renderSummon(): void {
    if (this.state.visible) {
      if (this.summonEl !== null) {
        this.summonEl.remove()
        this.summonEl = null
      }
      return
    }
    if (this.summonEl !== null) return
    const btn = document.createElement('button')
    btn.className = 'sysmon-summon'
    btn.textContent = '性能'
    btn.title = '显示系统性能看板'
    btn.style.position = 'fixed'
    btn.style.right = `${this.state.right}px`
    btn.style.bottom = `${this.state.bottom}px`
    btn.style.zIndex = '2147483647'
    btn.addEventListener('click', () => {
      this.state.visible = true
      saveState(this.state)
      if (this.summonEl !== null) {
        this.summonEl.remove()
        this.summonEl = null
      }
      document.body.appendChild(this.root)
      this.poll()
    })
    document.body.appendChild(btn)
    this.summonEl = btn
  }

  /** Hide the widget (keep position; show the summon button). */
  private hide(): void {
    this.state.visible = false
    saveState(this.state)
    this.root.remove()
    this.renderSummon()
  }

  /** Start the poll interval; pause while the tab is hidden (resumes on show).
   *  The visibilitychange listener stays attached — hiding only clears the
   *  interval, so coming back to the tab resumes polling with fresh data. */
  private start(): void {
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        this.poll()
        if (this.timer === undefined) {
          this.timer = window.setInterval(() => this.poll(), POLL_MS)
        }
      } else if (this.timer !== undefined) {
        window.clearInterval(this.timer)
        this.timer = undefined
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()
    this.visibilityCleanup = () => document.removeEventListener('visibilitychange', onVisibility)
  }

  /** Stop the poll interval and detach the visibility listener. */
  private stop(): void {
    if (this.timer !== undefined) {
      window.clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.visibilityCleanup !== null) {
      this.visibilityCleanup()
      this.visibilityCleanup = null
    }
  }
}

/** Required services: slots (settings card seat) + settingsScope (enabled switch) + locale. */
export const inject = ['slots', 'settingsScope', 'locale', 'connection']

/** Dictionary namespace owned by this package. */
const NS = 'sysmon'

/** Settings namespace the sysmon settings card edits (the Host plugin registers it). */
const SYSMON_NS = 'sysmon'

/**
 * Client plugin body: register the settings card and mount the floating
 * window while the `sysmon` settings switch is enabled.
 * @param ctx - client root context (slots + settingsScope + cordis base).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sysmon: dictionaries')

  const settingsScope = ctx.settingsScope.bind<SysmonSettings>({ namespace: SYSMON_NS })
  const enabled = (): boolean => {
    const snapshot = settingsScope.getSnapshot()
    return snapshot.status === 'ready'
      ? snapshot.value?.enabled ?? true
      : snapshot.status === 'unavailable'
  }

  // Plugin configuration card: one staged form over the `sysmon` settings
  // namespace, contributed to the plugin-configuration section.
  const sysmonSettings = new SysmonSettingsCardController(settingsScope)
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'sysmon',
    order: 190,
    locale: NS,
    inject: () => sysmonSettings.inject(),
  }, SysmonSettingsCard))

  // The floating window mounts while the plugin is enabled; toggling the
  // setting off disposes the widget and stops its poll timer.
  let disposeWidget: (() => void) | undefined
  const syncWidget = (): void => {
    if (enabled() && disposeWidget === undefined) {
      disposeWidget = ctx.effect(() => {
        const widget = new SysmonWidget()
        widget.mount()
        return () => widget.dispose()
      }, 'sysmon: floating window')
    } else if (disposeWidget !== undefined && !enabled()) {
      disposeWidget()
      disposeWidget = undefined
    }
  }
  settingsScope.subscribe(() => { syncWidget() })
  syncWidget()
}
