/**
 * Pure memory-growth detector for repeated view-switch / mount-unmount cycles
 * (issue #10202 — "memory/performance budget tests that can detect monotonic
 * growth after repeated mount/unmount cycles").
 *
 * Modeled exactly on `hooks/frame-budget.ts`: a PURE, unit-tested reducer
 * (`summarizeMemorySamples`) plus a PURE threshold decision
 * (`shouldReportMemoryGrowth`). The live driver (the chromium e2e harness and
 * the app CDP ui-smoke spec) harvests real `performance.memory.usedJSHeapSize`
 * (or CDP `Performance.getMetrics` JSHeapUsedSize) once per switch cycle and
 * feeds the array here, so a leak fails a build deterministically instead of
 * only being eyeballed in a heap snapshot.
 *
 * A single heap reading is meaningless (GC is non-deterministic); the signal is
 * the TREND across many cycles. We compute a least-squares slope and a
 * monotonicity ratio so transient bumps (a GC that hasn't run yet) do not
 * false-positive, but a steady upward staircase does.
 */

export interface MemorySampleSummary {
  /** Number of heap samples provided. */
  sampleCount: number;
  /** First / last sampled heap size in bytes. */
  firstBytes: number;
  lastBytes: number;
  /** Min / max sampled heap size in bytes. */
  minBytes: number;
  maxBytes: number;
  /** Mean heap size in bytes. */
  meanBytes: number;
  /**
   * Least-squares slope in bytes-per-cycle. Positive = growing. This is the
   * primary leak signal: a bounded view-switch loop trends flat (slope ≈ 0),
   * a leak trends steadily positive.
   */
  slopeBytesPerCycle: number;
  /** last / first (1.0 = no net growth). */
  growthRatio: number;
  /** net growth in bytes (last - first). */
  netGrowthBytes: number;
  /**
   * Fraction of consecutive sample pairs where heap increased (0..1). A leak
   * climbs nearly every cycle (→ near 1); healthy churn sawtooths around GC
   * (→ near 0.5).
   */
  monotonicIncreaseRatio: number;
}

/** Least-squares slope of `values` against their index (bytes per cycle). */
function leastSquaresSlope(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

/** Reduce raw heap samples (bytes, one per cycle) to a trend summary. */
export function summarizeMemorySamples(
  samples: readonly number[],
): MemorySampleSummary {
  const valid = samples.filter(
    (s) => typeof s === "number" && Number.isFinite(s) && s >= 0,
  );
  const sampleCount = valid.length;
  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      firstBytes: 0,
      lastBytes: 0,
      minBytes: 0,
      maxBytes: 0,
      meanBytes: 0,
      slopeBytesPerCycle: 0,
      growthRatio: 1,
      netGrowthBytes: 0,
      monotonicIncreaseRatio: 0,
    };
  }

  const firstBytes = valid[0];
  const lastBytes = valid[sampleCount - 1];
  let minBytes = valid[0];
  let maxBytes = valid[0];
  let sum = 0;
  let increases = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const v = valid[i];
    if (v < minBytes) minBytes = v;
    if (v > maxBytes) maxBytes = v;
    sum += v;
    if (i > 0 && v > valid[i - 1]) increases += 1;
  }

  return {
    sampleCount,
    firstBytes,
    lastBytes,
    minBytes,
    maxBytes,
    meanBytes: sum / sampleCount,
    slopeBytesPerCycle: leastSquaresSlope(valid),
    growthRatio: firstBytes > 0 ? lastBytes / firstBytes : 1,
    netGrowthBytes: lastBytes - firstBytes,
    monotonicIncreaseRatio: sampleCount > 1 ? increases / (sampleCount - 1) : 0,
  };
}

export interface MemoryBudgetOptions {
  /**
   * Max tolerated per-cycle slope in bytes. A bounded view-switch loop should
   * trend flat; default 512 KiB/cycle leaves headroom for measurement jitter
   * while catching a real per-switch retention.
   */
  maxSlopeBytesPerCycle?: number;
  /** Max tolerated net growth ratio (last/first). Default 1.5 (50% growth). */
  maxGrowthRatio?: number;
  /**
   * Min monotonic-increase ratio for the slope to count as a real leak rather
   * than noise. A leak climbs most cycles; default 0.6 means "increased on >60%
   * of cycles". Below this the slope is treated as churn even if positive.
   */
  minMonotonicRatio?: number;
  /** Minimum samples before any judgement is made. Default 5. */
  minSamples?: number;
}

export const DEFAULT_MEMORY_BUDGET_OPTIONS: Required<MemoryBudgetOptions> = {
  maxSlopeBytesPerCycle: 512 * 1024,
  maxGrowthRatio: 1.5,
  minMonotonicRatio: 0.6,
  minSamples: 5,
};

export interface MemoryBudgetReport {
  /** True when the trend looks like a real leak (fail the build). */
  leaking: boolean;
  /** Human-readable reasons the budget was breached (empty when not leaking). */
  reasons: string[];
  summary: MemorySampleSummary;
}

/**
 * Decide whether a heap-sample trend indicates a leak. A leak must show BOTH a
 * sustained positive slope AND mostly-monotonic growth AND a net growth ratio
 * over budget — so a single GC-delayed bump cannot trip it, but a steady
 * per-switch staircase does.
 */
export function shouldReportMemoryGrowth(
  summary: MemorySampleSummary,
  options: MemoryBudgetOptions = {},
): MemoryBudgetReport {
  const opts = { ...DEFAULT_MEMORY_BUDGET_OPTIONS, ...options };
  const reasons: string[] = [];

  if (summary.sampleCount < opts.minSamples) {
    return { leaking: false, reasons, summary };
  }

  const slopeOverBudget =
    summary.slopeBytesPerCycle > opts.maxSlopeBytesPerCycle;
  const growthOverBudget = summary.growthRatio > opts.maxGrowthRatio;
  const mostlyMonotonic =
    summary.monotonicIncreaseRatio >= opts.minMonotonicRatio;

  // A real leak trends up nearly every cycle. Require monotonicity for EITHER
  // signal to count, so a sawtooth that happens to end high (last GC late) is
  // not flagged.
  if (mostlyMonotonic && slopeOverBudget) {
    reasons.push(
      `slope ${(summary.slopeBytesPerCycle / 1024).toFixed(1)} KiB/cycle ` +
        `> ${(opts.maxSlopeBytesPerCycle / 1024).toFixed(0)} KiB/cycle ` +
        `over ${summary.sampleCount} cycles (monotonic ${(
          summary.monotonicIncreaseRatio * 100
        ).toFixed(0)}%)`,
    );
  }
  if (mostlyMonotonic && growthOverBudget) {
    reasons.push(
      `heap grew ${(summary.growthRatio * 100 - 100).toFixed(0)}% ` +
        `(${(summary.firstBytes / 1024 / 1024).toFixed(1)} → ` +
        `${(summary.lastBytes / 1024 / 1024).toFixed(1)} MiB) ` +
        `> ${((opts.maxGrowthRatio - 1) * 100).toFixed(0)}% budget`,
    );
  }

  return { leaking: reasons.length > 0, reasons, summary };
}
