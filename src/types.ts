/**
 * Shared sysmon wire types — used by both halves. Pure types only, so the
 * browser bundle can import them without pulling node built-ins.
 * @module @dsh-external/dsh-sysmon/types
 */

/** One physical disk mount's usage. */
export interface DiskMount {
  /** Mount point path, e.g. "/" or "/home". */
  mount: string
  /** Used bytes (aligned with GNU df: reserved blocks not counted). */
  used: number
  /** Total bytes. */
  total: number
  /** Usage percent (0-100, one decimal). */
  percent: number
}

/** How {@link SysmonSnapshot.netTop} was ranked and measured. */
export type NetTopMode =
  /** Byte-rate mode: `rxRate`/`txRate` hold EMA-smoothed bytes/s deltas. */
  | 'rate'
  /** Connections mode: the local `ss` reports no byte counters, so the list
   *  ranks by active TCP connection count (rates read as zero). */
  | 'connections'

/** One process's network activity (per-process aggregation of TCP sockets). */
export interface NetProcRate {
  /** Process comm name (as reported by `ss -p`). */
  name: string
  /** Process pid. */
  pid: number
  /** Receive rate in bytes/s (EMA-smoothed between `ss` samples; 0 in
   *  connections mode). */
  rxRate: number
  /** Transmit rate in bytes/s (EMA-smoothed between `ss` samples; 0 in
   *  connections mode). */
  txRate: number
  /** Active TCP socket count (same-user sockets with a visible pid). */
  conns: number
  /** Currently queued bytes (Recv-Q + Send-Q across ESTAB sockets). */
  queue: number
}

/** Live snapshot served by `GET /api/sysmon/snapshot`. */
export interface SysmonSnapshot {
  /** Epoch milliseconds of the underlying sample. */
  ts: number
  /** Node hostname. */
  hostname: string
  /** Seconds since boot. */
  uptime: number
  /** 1/5/15-minute load averages. */
  load: number[]
  /** CPU usage percent (0-100, one decimal), null when unavailable. */
  cpu: number | null
  /** Memory usage percent (0-100, one decimal). */
  memPercent: number
  /** Memory used / total in bytes. */
  mem: { used: number; total: number }
  /**
   * Disk mount usage, root ("/") first then by used bytes descending.
   * Virtual/pseudo filesystems (proc, sysfs, tmpfs, cgroup, ...) are filtered
   * out; empty when no physical mount could be read.
   */
  disks: DiskMount[]
  /** Network receive rate in bytes/s, null when unavailable. */
  netRxRate: number | null
  /** Network transmit rate in bytes/s, null when unavailable. */
  netTxRate: number | null
  /**
   * Top processes by network activity (capped at 10), sampled from
   * `ss -tinp` — TCP sockets of the same user only. Ranking depends on
   * {@link netTopMode}: byte-rate deltas when the ss build reports counters,
   * active connection count otherwise. Empty while warming up (first sample)
   * or when the sampler is unavailable (non-Linux, missing iproute2).
   */
  netTop: NetProcRate[]
  /** How {@link netTop} was ranked and measured. */
  netTopMode: NetTopMode
  /** Running process count (Linux), null elsewhere. */
  procs: number | null
  /** GPU utilization percent (0-100), null when no GPU / driver source. */
  gpuPercent: number | null
  /** GPU VRAM used / total in bytes, null when unavailable. */
  gpuMem: { used: number; total: number } | null
}
