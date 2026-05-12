/**
 * Inference-stats JSONL parsing + windowed aggregation.
 *
 * Sister-agent contract for `~/.milady/inference-stats.jsonl` rows:
 *   {"ts","label","tokens_per_sec","p50_tpot_ms","p95_tpot_ms",
 *    "kv_cache_usage_pct","num_requests_running","spec_decode_accept_rate",
 *    "apc_hit_rate","peak_vram_mb"}
 * Error rows take the form `{"ts","label","error"}` and are skipped on read.
 */

export interface InferenceStatRow {
  ts: string;
  label: string;
  tokens_per_sec: number | null;
  p50_tpot_ms: number | null;
  p95_tpot_ms: number | null;
  kv_cache_usage_pct: number | null;
  num_requests_running: number | null;
  spec_decode_accept_rate: number | null;
  apc_hit_rate: number | null;
  peak_vram_mb: number | null;
}

export interface InferenceStatsAggregate {
  label: string | null;
  window_minutes: number;
  sample_count: number;
  tokens_per_sec_avg: number | null;
  p50_tpot_ms_avg: number | null;
  p95_tpot_ms_max: number | null;
  kv_cache_usage_pct_avg: number | null;
  spec_decode_accept_rate_avg: number | null;
  apc_hit_rate_avg: number | null;
  peak_vram_mb_max: number | null;
}

export function parseStatRow(line: string): InferenceStatRow | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.error === "string") return null; // error rows are skipped per spec
  if (typeof obj.ts !== "string" || typeof obj.label !== "string") return null;
  return {
    ts: obj.ts,
    label: obj.label,
    tokens_per_sec: numericOrNull(obj.tokens_per_sec),
    p50_tpot_ms: numericOrNull(obj.p50_tpot_ms),
    p95_tpot_ms: numericOrNull(obj.p95_tpot_ms),
    kv_cache_usage_pct: numericOrNull(obj.kv_cache_usage_pct),
    num_requests_running: numericOrNull(obj.num_requests_running),
    spec_decode_accept_rate: numericOrNull(obj.spec_decode_accept_rate),
    apc_hit_rate: numericOrNull(obj.apc_hit_rate),
    peak_vram_mb: numericOrNull(obj.peak_vram_mb),
  };
}

export function aggregateInferenceStats(
  samples: InferenceStatRow[],
  label: string | null,
  lastMinutes: number,
): InferenceStatsAggregate {
  if (samples.length === 0)
    return emptyInferenceStatsAggregate(label, lastMinutes);
  return {
    label,
    window_minutes: lastMinutes,
    sample_count: samples.length,
    tokens_per_sec_avg: avg(samples.map((s) => s.tokens_per_sec)),
    p50_tpot_ms_avg: avg(samples.map((s) => s.p50_tpot_ms)),
    p95_tpot_ms_max: maxOf(samples.map((s) => s.p95_tpot_ms)),
    kv_cache_usage_pct_avg: avg(samples.map((s) => s.kv_cache_usage_pct)),
    spec_decode_accept_rate_avg: avg(
      samples.map((s) => s.spec_decode_accept_rate),
    ),
    apc_hit_rate_avg: avg(samples.map((s) => s.apc_hit_rate)),
    peak_vram_mb_max: maxOf(samples.map((s) => s.peak_vram_mb)),
  };
}

export function emptyInferenceStatsAggregate(
  label: string | null,
  lastMinutes: number,
): InferenceStatsAggregate {
  return {
    label,
    window_minutes: lastMinutes,
    sample_count: 0,
    tokens_per_sec_avg: null,
    p50_tpot_ms_avg: null,
    p95_tpot_ms_max: null,
    kv_cache_usage_pct_avg: null,
    spec_decode_accept_rate_avg: null,
    apc_hit_rate_avg: null,
    peak_vram_mb_max: null,
  };
}

function numericOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function avg(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  let sum = 0;
  for (const n of nums) sum += n;
  return sum / nums.length;
}

function maxOf(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  let m = nums[0];
  for (let i = 1; i < nums.length; i += 1) {
    if (nums[i] > m) m = nums[i];
  }
  return m;
}
