/**
 * Zero-dependency system metrics collector.
 *
 * Reads Linux `/proc` files (stat / meminfo / net/dev / mounts) plus
 * `node:os` and `fs.statfsSync` — no third-party npm dependency. CPU and
 * network rates are computed as deltas between two samples; the collector
 * caches its last snapshot for `cacheMs` so the browser half can poll freely
 * without re-reading `/proc` on every request. The only subprocess is a
 * background `ss -tinp` query (every {@link SS_SAMPLE_MS}) that aggregates
 * TCP byte counters per process for the hover TOP10 list — async, never
 * blocking the event loop.
 *
 * GPU: AMD sysfs (`/sys/class/drm/cardN/device/gpu_busy_percent` with N a
 * digit, plus `mem_info_vram_used` / `mem_info_vram_total`) is read directly
 * with zero subprocesses; NVIDIA falls back to a `nvidia-smi` query run by a
 * background async sampler (one invocation per {@link GPU_CACHE_MS}, never
 * blocking the event loop).
 *
 * Non-Linux fallbacks: CPU from `os.cpus()` tick deltas, memory from
 * `os.totalmem()/freemem()`, disk from `statfs`, network, process count and
 * GPU reported as unavailable (null).
 * @module @dsh-external/dsh-sysmon/metrics
 */

import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, statfsSync } from 'node:fs'
import { promisify } from 'node:util'
import { cpus, freemem, hostname, loadavg, totalmem, uptime } from 'node:os'
import type { DiskMount, NetProcRate, NetTopMode, SysmonSnapshot } from './types.js'

/** GPU sample interval (ms). The nvidia-smi query runs async in the
 *  background, so this only bounds how often a subprocess is spawned. */
const GPU_CACHE_MS = 5000

/** Per-process network sample interval (ms): one `ss -tinp` per tick, async. */
const SS_SAMPLE_MS = 3000

/** EMA smoothing factor for per-process rates (0.6 new / 0.4 previous). */
const NET_RATE_EMA = 0.6

/** Max disk mounts reported per snapshot (keep the widget compact). */
const MAX_DISKS = 6

/** Filesystem types that are virtual/pseudo — never reported as disks. */
const VIRTUAL_FSTYPES = new Set([
  'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2',
  'pstore', 'securityfs', 'debugfs', 'tracefs', 'hugetlbfs', 'mqueue',
  'configfs', 'fusectl', 'bpf', 'ramfs', 'autofs', 'binfmt_misc',
  'rpc_pipefs', 'nsfs', 'fuse.gvfsd-fuse', 'squashfs',
])

/** One CPU tick counter snapshot (jiffies). */
interface CpuTicks {
  /** Sum of all jiffies across every state. */
  total: number
  /** Idle jiffies (idle + iowait). */
  idle: number
}

/** One network byte counter snapshot (non-loopback interfaces). */
interface NetBytes {
  /** Total received bytes. */
  rx: number
  /** Total transmitted bytes. */
  tx: number
}

/** One GPU utilization/VRAM snapshot. */
interface GpuSample {
  /** Utilization percent (0-100), null when unavailable. */
  percent: number | null
  /** VRAM used / total in bytes, null when unavailable. */
  mem: { used: number; total: number } | null
}

/** Read one small text file; returns null instead of throwing. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Read AMD sysfs GPU metrics (zero subprocess). */
function readAmdGpu(): GpuSample | null {
  try {
    const dirs = readdirSync('/sys/class/drm')
    for (const name of dirs) {
      if (!/^card\d+$/.test(name)) continue
      const base = `/sys/class/drm/${name}/device`
      const busy = readText(`${base}/gpu_busy_percent`)
      const used = readText(`${base}/mem_info_vram_used`)
      const total = readText(`${base}/mem_info_vram_total`)
      if (busy === null && (used === null || total === null)) continue
      const mem = used !== null && total !== null
        ? { used: Number.parseInt(used.trim(), 10), total: Number.parseInt(total.trim(), 10) }
        : null
      if (mem !== null && (Number.isNaN(mem.used) || Number.isNaN(mem.total))) continue
      const percent = busy !== null ? Number.parseInt(busy.trim(), 10) : null
      if (percent !== null && Number.isNaN(percent)) continue
      return { percent, mem }
    }
  } catch {
    return null
  }
  return null
}

const execFileP = promisify(execFile)

/** Query NVIDIA GPU metrics via nvidia-smi (async — never blocks the event loop). */
async function readNvidiaGpu(): Promise<GpuSample | null> {
  try {
    const { stdout } = await execFileP('nvidia-smi', [
      '--query-gpu=utilization.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true })
    const line = stdout.trim().split('\n')[0]
    if (line === undefined) return null
    const parts = line.split(',').map((s) => Number.parseInt(s.trim(), 10))
    const percent = parts[0] ?? NaN
    const usedMb = parts[1] ?? NaN
    const totalMb = parts[2] ?? NaN
    if (Number.isNaN(percent) || Number.isNaN(usedMb) || Number.isNaN(totalMb) || totalMb <= 0) return null
    return {
      percent: Math.min(100, Math.max(0, percent)),
      mem: { used: usedMb * 1024 * 1024, total: totalMb * 1024 * 1024 },
    }
  } catch {
    return null
  }
}

/** Read GPU metrics: AMD sysfs first (free), NVIDIA nvidia-smi fallback (async). */
async function readGpu(): Promise<GpuSample | null> {
  return readAmdGpu() ?? (await readNvidiaGpu())
}

/** Parse `/proc/stat` first line (`cpu  user nice system idle ...`). */
function readCpuTicks(): CpuTicks | null {
  const stat = readText('/proc/stat')
  if (stat === null) return null
  const line = stat.split('\n')[0]
  if (line === undefined || !line.startsWith('cpu ')) return null
  const parts = line.trim().split(/\s+/).slice(1).map(Number)
  if (parts.length < 4 || parts.some((n) => Number.isNaN(n))) return null
  const total = parts.reduce((a, b) => a + b, 0)
  const idle = (parts[3] ?? 0) + (parts[4] ?? 0)
  return { total, idle }
}

/** Parse `/proc/meminfo` MemTotal/MemAvailable (kB). */
function readMemKb(): { total: number; available: number } | null {
  const info = readText('/proc/meminfo')
  if (info === null) return null
  let total: number | null = null
  let available: number | null = null
  for (const line of info.split('\n')) {
    if (line.startsWith('MemTotal:')) total = Number.parseInt(line.split(/\s+/)[1] ?? '', 10)
    else if (line.startsWith('MemAvailable:')) available = Number.parseInt(line.split(/\s+/)[1] ?? '', 10)
    if (total !== null && available !== null) break
  }
  if (total === null || available === null || Number.isNaN(total) || Number.isNaN(available)) return null
  return { total: total * 1024, available: available * 1024 }
}

/** Parse `/proc/net/dev` byte counters, summing non-loopback interfaces. */
function readNetBytes(): NetBytes | null {
  const dev = readText('/proc/net/dev')
  if (dev === null) return null
  let rx = 0
  let tx = 0
  let found = false
  for (const line of dev.split('\n').slice(2)) {
    const m = /^\s*([^:]+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/.exec(line)
    if (m === null) continue
    const iface = m[1]
    if (iface === 'lo') continue
    found = true
    rx += Number.parseInt(m[2] ?? '0', 10)
    tx += Number.parseInt(m[3] ?? '0', 10)
  }
  return found ? { rx, tx } : null
}

/** Count `/proc` numeric directories (running processes, Linux). */
function readProcs(): number | null {
  try {
    let n = 0
    for (const name of readdirSync('/proc')) {
      if (/^\d+$/.test(name)) n += 1
    }
    return n
  } catch {
    return null
  }
}

/** One parsed TCP socket record from `ss -tinp`. */
interface SsSocket {
  /** User entries (name/pid) from the `users:(...)` column. */
  users: Array<{ name: string; pid: number }>
  /** Recv-Q / Send-Q (current queued bytes, main-line columns 2-3). */
  recvQ: number
  sendQ: number
  /** Cumulative counters from tcp_info lines (0 when the ss build omits
   *  them — some minimal builds / exotic stacks report no bytes). */
  bytesRx: number
  bytesTx: number
}

/** Per-process aggregation of one `ss -tinp` sample. */
interface ProcNetSample {
  name: string
  pid: number
  /** Cumulative received bytes across all sockets. */
  rx: number
  /** Cumulative sent bytes across all sockets. */
  tx: number
  /** Number of sockets carrying a visible user. */
  conns: number
  /** Current queued bytes (Recv-Q + Send-Q, ESTAB sockets only). */
  queue: number
}

/**
 * Parse `ss -tinp` output into per-process aggregations.
 *
 * Each TCP socket is one record: a main line
 * `STATE Recv-Q Send-Q local peer users:(("name",pid=N,fd=M)) ...` (possibly
 * several user entries), optionally followed by indented `tcp_info` lines
 * carrying `bytes_sent:` / `bytes_received:` cumulative counters. Sockets
 * without a visible user (kernel sockets, other users' sockets under
 * non-root `ss -p`) are skipped — the result covers TCP sockets of the
 * current user only.
 * @param stdout - raw `ss -tinp` output.
 * @returns per-process aggregations, plus whether any byte counters existed
 * (drives the rate-vs-connections ranking mode).
 */
function parseSsTinp(stdout: string): { procs: Map<string, ProcNetSample>; hasBytes: boolean } {
  const procs = new Map<string, ProcNetSample>()
  let users: SsSocket['users'] = []
  let recvQ = 0
  let sendQ = 0
  let bytesRx = 0
  let bytesTx = 0
  let hasBytes = false
  const flush = (): void => {
    for (const u of users) {
      const key = `${u.pid}:${u.name}`
      const cur = procs.get(key)
      if (cur !== undefined) {
        cur.rx += bytesRx
        cur.tx += bytesTx
        cur.conns += 1
        cur.queue += recvQ + sendQ
      } else {
        procs.set(key, { name: u.name, pid: u.pid, rx: bytesRx, tx: bytesTx, conns: 1, queue: recvQ + sendQ })
      }
    }
    users = []
    recvQ = 0
    sendQ = 0
    bytesRx = 0
    bytesTx = 0
  }
  for (const line of stdout.split('\n')) {
    if (line === '' || line.startsWith('State')) continue
    if (line.startsWith(' ') || line.startsWith('\t')) {
      // Indented tcp_info continuation line — accumulate byte counters.
      const mRx = /bytes_received:(\d+)/.exec(line)
      const mTx = /bytes_sent:(\d+)/.exec(line)
      if (mRx !== null) {
        bytesRx += Number.parseInt(mRx[1] ?? '0', 10)
        hasBytes = true
      }
      if (mTx !== null) {
        bytesTx += Number.parseInt(mTx[1] ?? '0', 10)
        hasBytes = true
      }
    } else {
      // New socket record (starts with a state name).
      flush()
      const m = /^(\S+)\s+(\d+)\s+(\d+)/.exec(line)
      if (m !== null && m[1] !== 'LISTEN') {
        // For LISTEN sockets Send-Q is the backlog count, not queued bytes.
        recvQ = Number.parseInt(m[2] ?? '0', 10)
        sendQ = Number.parseInt(m[3] ?? '0', 10)
      }
      for (const u of line.matchAll(/"([^"]*)",pid=(\d+)/g)) {
        users.push({ name: u[1] ?? '', pid: Number.parseInt(u[2] ?? '0', 10) })
      }
    }
  }
  flush()
  return { procs, hasBytes }
}

/** Compute percent with one decimal; clamps to 0-100. */
function percent(used: number, total: number): number {
  if (total <= 0) return 0
  const p = (used / total) * 100
  return Math.round(Math.min(100, Math.max(0, p)) * 10) / 10
}

/** Read one mount's usage via statfs, or null when unavailable. */
function readMountUsage(mount: string): DiskMount | null {
  try {
    const info = statfsSync(mount)
    const total = info.blocks * info.bsize
    // Align with GNU df: used = blocks - bfree (reserved blocks are NOT
    // counted as used), percent = used / (used + bavail).
    const used = Math.max(0, total - info.bfree * info.bsize)
    const avail = Math.max(0, info.bavail * info.bsize)
    return { mount, used, total, percent: percent(used, used + avail) }
  } catch {
    return null
  }
}

/**
 * Collect physical disk mounts: root ("/") first, then by used bytes
 * descending. Virtual filesystems and duplicate devices are skipped; the
 * result is capped at {@link MAX_DISKS}. Falls back to the root filesystem
 * when `/proc/mounts` is unavailable (non-Linux, unreadable, no match).
 */
function readDiskMounts(): DiskMount[] {
  if (process.platform === 'linux') {
    const mounts = readText('/proc/mounts')
    if (mounts !== null) {
      const seen = new Set<string>()
      const out: DiskMount[] = []
      for (const line of mounts.split('\n')) {
        const parts = line.trim().split(/\s+/)
        const device = parts[0] ?? ''
        const mount = (parts[1] ?? '').replace(/\\040/g, ' ')
        const fstype = parts[2] ?? ''
        if (device === '' || mount === '' || fstype === '') continue
        if (VIRTUAL_FSTYPES.has(fstype)) continue
        // Bind mounts / btrfs subvols share a device string; keep the first.
        if (seen.has(device)) continue
        seen.add(device)
        const usage = readMountUsage(mount)
        if (usage !== null) out.push(usage)
      }
      if (out.length > 0) {
        out.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : b.used - a.used))
        return out.slice(0, MAX_DISKS)
      }
    }
  }
  const root = readMountUsage('/')
  return root === null ? [] : [root]
}

/** Delta-based rate (per second) between two timestamps. */
function perSecond(delta: number, dtMs: number): number | null {
  if (dtMs <= 0) return null
  return (delta / dtMs) * 1000
}

/**
 * Collects and caches system metrics. CPU/network deltas need two samples, so
 * {@link snapshot} keeps the previous raw counters and the wall time of the
 * last computation; within `cacheMs` it returns the cached snapshot verbatim.
 */
export class SysmonCollector {
  private lastCpu: CpuTicks | null = null
  private lastNet: NetBytes | null = null
  private lastAt = 0
  private cached: SysmonSnapshot | null = null
  // GPU is sampled on its own slower cadence by a background async loop, so
  // the synchronous snapshot never spawns a subprocess.
  private gpu: GpuSample | null = null
  private gpuTimer: NodeJS.Timeout | null = null
  /** Generation token: dispose() bumps it so an in-flight sample is dropped. */
  private gpuGen = 0
  // Per-process network: background async `ss -tinp` sampler (TCP of the
  // current user), with cumulative counters carried between samples so the
  // top-N list holds byte-rate deltas instead of connection totals. When the
  // local ss build reports no byte counters, falls back to ranking by active
  // connection count (see {@link sampleNetProc}).
  private netTop: NetProcRate[] = []
  private netTopMode: NetTopMode = 'connections'
  private netProcCum: Map<string, ProcNetSample> | null = null
  private netProcPrev: Map<string, NetProcRate> = new Map()
  private netProcPrevAt = 0
  private netTimer: NodeJS.Timeout | null = null
  private netGen = 0
  /** `ss` is unavailable (non-Linux or missing binary) — sampler disabled. */
  private netDisabled = false

  constructor(private readonly cacheMs: number) {}

  /** Start the background GPU sampler (async — zero event-loop blocking). */
  start(): void {
    if (this.gpuTimer !== null) return
    const gen = ++this.gpuGen
    const tick = async (): Promise<void> => {
      const sample = await readGpu()
      if (gen !== this.gpuGen) return
      this.gpu = sample
      this.gpuTimer = setTimeout(() => void tick(), GPU_CACHE_MS)
      this.gpuTimer.unref()
    }
    void tick()
    this.startNetSampler()
  }

  /** Start the per-process network sampler (Linux + `ss` only, async). */
  private startNetSampler(): void {
    if (this.netTimer !== null || this.netDisabled) return
    if (process.platform !== 'linux') {
      this.netDisabled = true
      return
    }
    const gen = ++this.netGen
    const tick = async (): Promise<void> => {
      if (gen !== this.netGen) return
      await this.sampleNetProc()
      if (gen !== this.netGen) return
      this.netTimer = setTimeout(() => void tick(), SS_SAMPLE_MS)
      this.netTimer.unref()
    }
    void tick()
  }

  /** One `ss -tinp` sample: aggregate per process, diff against the previous
   *  sample, EMA-smooth, and refresh the top-10 list. When the ss build
   *  reports no byte counters anywhere, ranks by active connection count
   *  instead (rates then read as zero). Never throws. */
  private async sampleNetProc(): Promise<void> {
    let stdout: string
    try {
      const { stdout: out } = await execFileP('ss', ['-tinp'], {
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      })
      stdout = out
    } catch (error) {
      // Missing binary → disable forever; anything else (transient) retries
      // on the next tick and leaves the last top list in place.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.netDisabled = true
      return
    }
    const { procs, hasBytes } = parseSsTinp(stdout)
    const now = Date.now()
    const prevCum = this.netProcCum
    const dtMs = prevCum === null ? 0 : now - this.netProcPrevAt
    this.netProcCum = procs
    this.netProcPrevAt = now

    if (hasBytes) {
      // Rate mode — byte counters available: delta between samples, EMA-smoothed.
      const rates = new Map<string, NetProcRate>()
      if (prevCum !== null && dtMs > 0) {
        for (const [key, cur] of procs) {
          const old = prevCum.get(key)
          if (old === undefined) continue // first sighting — baseline next tick
          const rxRate = Math.max(0, ((cur.rx - old.rx) / dtMs) * 1000)
          const txRate = Math.max(0, ((cur.tx - old.tx) / dtMs) * 1000)
          const last = this.netProcPrev.get(key)
          rates.set(key, {
            name: cur.name,
            pid: cur.pid,
            rxRate: last === undefined
              ? Math.round(rxRate)
              : Math.round(last.rxRate * (1 - NET_RATE_EMA) + rxRate * NET_RATE_EMA),
            txRate: last === undefined
              ? Math.round(txRate)
              : Math.round(last.txRate * (1 - NET_RATE_EMA) + txRate * NET_RATE_EMA),
            conns: cur.conns,
            queue: cur.queue,
          })
        }
      }
      this.netProcPrev = rates
      this.netTopMode = 'rate'
      this.netTop = [...rates.values()]
        .filter((r) => r.rxRate > 0 || r.txRate > 0)
        .sort((a, b) => b.rxRate + b.txRate - (a.rxRate + a.txRate))
        .slice(0, 10)
    } else {
      // Connections mode — this ss build exposes no byte counters (minimal
      // builds, exotic stacks): rank by active connection count, then by
      // currently queued bytes. Always non-empty while any socket is visible.
      this.netProcPrev = new Map()
      this.netTopMode = 'connections'
      this.netTop = [...procs.values()]
        .map((p) => ({ name: p.name, pid: p.pid, rxRate: 0, txRate: 0, conns: p.conns, queue: p.queue }))
        .sort((a, b) => b.conns - a.conns || b.queue - a.queue)
        .slice(0, 10)
    }
  }

  /** Stop the background GPU sampler. */
  dispose(): void {
    this.gpuGen += 1
    if (this.gpuTimer !== null) {
      clearTimeout(this.gpuTimer)
      this.gpuTimer = null
    }
    this.netGen += 1
    if (this.netTimer !== null) {
      clearTimeout(this.netTimer)
      this.netTimer = null
    }
  }

  /** Whether the collector runs on Linux `/proc` (drives fallbacks). */
  private get isLinux(): boolean {
    return process.platform === 'linux'
  }

  /**
   * Return the current snapshot, recomputing at most every `cacheMs`.
   * @returns a fresh or cached snapshot.
   */
  snapshot(): SysmonSnapshot {
    const now = Date.now()
    if (this.cached !== null && now - this.lastAt < this.cacheMs) {
      return this.cached
    }
    this.cached = this.compute(now)
    this.lastAt = now
    return this.cached
  }

  private compute(now: number): SysmonSnapshot {
    const dtMs = now - this.lastAt

    // GPU — cached value refreshed by the background sampler (start()).
    const gpu = this.gpu

    // CPU — Linux: /proc/stat jiffies deltas; fallback: os.cpus() tick deltas.
    let cpu: number | null = null
    const cpuTicks = this.isLinux ? readCpuTicks() : readCpuTicksFromOs()
    if (cpuTicks !== null && this.lastCpu !== null && dtMs > 0) {
      const dTotal = cpuTicks.total - this.lastCpu.total
      const dIdle = cpuTicks.idle - this.lastCpu.idle
      if (dTotal > 0) {
        cpu = Math.round(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)) * 10) / 10
      }
    }
    if (cpuTicks !== null) this.lastCpu = cpuTicks

    // Memory — Linux: MemAvailable; fallback: os.freemem().
    let memUsed = 0
    let memTotal = 0
    const memInfo = this.isLinux ? readMemKb() : null
    if (memInfo !== null) {
      memTotal = memInfo.total
      memUsed = Math.max(0, memTotal - memInfo.available)
    } else {
      memTotal = totalmem()
      memUsed = Math.max(0, memTotal - freemem())
    }

    // Disk — all physical mounts (Linux: /proc/mounts + statfs; root fallback).
    const disks = readDiskMounts()

    // Network — /proc/net/dev byte deltas (Linux only).
    let netRxRate: number | null = null
    let netTxRate: number | null = null
    const netBytes = this.isLinux ? readNetBytes() : null
    if (netBytes !== null && this.lastNet !== null) {
      netRxRate = perSecond(netBytes.rx - this.lastNet.rx, dtMs)
      netTxRate = perSecond(netBytes.tx - this.lastNet.tx, dtMs)
    }
    if (netBytes !== null) this.lastNet = netBytes

    return {
      ts: now,
      hostname: hostname(),
      uptime: uptime(),
      load: loadavg(),
      cpu,
      memPercent: percent(memUsed, memTotal),
      mem: { used: memUsed, total: memTotal },
      disks,
      netRxRate,
      netTxRate,
      netTop: this.netTop,
      netTopMode: this.netTopMode,
      procs: this.isLinux ? readProcs() : null,
      gpuPercent: gpu?.percent ?? null,
      gpuMem: gpu?.mem ?? null,
    }
  }
}

/** Cross-platform CPU tick snapshot from `os.cpus()` (fallback path). */
function readCpuTicksFromOs(): CpuTicks | null {
  const cores = cpus()
  let total = 0
  let idle = 0
  for (const core of cores) {
    const t = core.times
    total += t.user + t.nice + t.sys + t.idle + t.irq
    idle += t.idle
  }
  return { total, idle }
}
