// Frame-budget measurement for the dashboard shell (issue #9141, task 1).
//
// The render-telemetry stack (useRenderGuard / RenderTelemetryProfiler) detects
// runaway *render loops* — too many React commits per second. It says nothing
// about *dropped frames*: a single expensive layout/paint or a main-thread long
// task blows the 60/120fps budget without ever tripping a commit-rate threshold.
// This module is the missing measurement — a pure summarizer over a window of
// requestAnimationFrame deltas plus PerformanceObserver('longtask') counts, so
// the live HUD and any KPI spec can read the same numbers from the same math.
//
// Everything here is pure and deterministic (no rAF, no DOM) so it unit-tests
// cleanly; the rAF/observer glue lives in ./useFrameBudgetMonitor.

/** A frame-rate target. 60 → a 16.67ms budget; 120 → 8.33ms (ProMotion). */
export interface FrameBudget {
  targetFps: number;
}

export const DEFAULT_FRAME_BUDGET: FrameBudget = { targetFps: 60 };

/** The per-frame budget in milliseconds for a target frame rate. */
export function frameBudgetMs(
  budget: FrameBudget = DEFAULT_FRAME_BUDGET,
): number {
  return 1000 / budget.targetFps;
}

export interface FrameBudgetSummary {
  /** Number of frame-duration samples in the window. */
  sampleCount: number;
  /** Observed frame rate, derived from the mean frame duration. */
  fps: number;
  /** Mean frame duration (ms). */
  meanFrameMs: number;
  /** 95th-percentile frame duration (ms) — the number the budget is asserted on. */
  p95FrameMs: number;
  /** Slowest single frame in the window (ms). */
  worstFrameMs: number;
  /** Frames whose duration exceeded the budget (i.e. a dropped/janky frame). */
  droppedFrames: number;
  /** `PerformanceObserver('longtask')` entries observed in the window. */
  longTasks: number;
  /** The per-frame budget the summary was computed against (ms). */
  budgetMs: number;
}

const EMPTY_SUMMARY = (budgetMs: number): FrameBudgetSummary => ({
  sampleCount: 0,
  fps: 0,
  meanFrameMs: 0,
  p95FrameMs: 0,
  worstFrameMs: 0,
  droppedFrames: 0,
  longTasks: 0,
  budgetMs,
});

/**
 * Nearest-rank percentile over an unsorted sample set. `p` is a fraction in
 * (0, 1]; an empty set yields 0. Deterministic — no interpolation, so the same
 * samples always yield the same number (stable for snapshot/KPI assertions).
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clampedP = Math.min(1, Math.max(0, p));
  const rank = Math.ceil(clampedP * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/**
 * Reduce a window of frame durations into a budget summary. `frameDurationsMs`
 * is the list of inter-frame deltas (ms); `longTasks` is the count of long-task
 * entries seen in the same window.
 */
export function summarizeFrameSamples(
  frameDurationsMs: readonly number[],
  longTasks = 0,
  budget: FrameBudget = DEFAULT_FRAME_BUDGET,
): FrameBudgetSummary {
  const budgetMs = frameBudgetMs(budget);
  // Ignore non-finite / negative deltas (tab-switch gaps, clock skew) — they are
  // not real frames and would otherwise poison the mean and worst-frame stats.
  const samples = frameDurationsMs.filter(
    (delta) => Number.isFinite(delta) && delta >= 0,
  );
  if (samples.length === 0) {
    return { ...EMPTY_SUMMARY(budgetMs), longTasks };
  }

  const total = samples.reduce((sum, delta) => sum + delta, 0);
  const meanFrameMs = total / samples.length;
  const worstFrameMs = samples.reduce((max, delta) => Math.max(max, delta), 0);
  const droppedFrames = samples.filter((delta) => delta > budgetMs).length;

  return {
    sampleCount: samples.length,
    fps: meanFrameMs > 0 ? 1000 / meanFrameMs : 0,
    meanFrameMs,
    p95FrameMs: percentile(samples, 0.95),
    worstFrameMs,
    droppedFrames,
    longTasks,
    budgetMs,
  };
}

export interface FrameBudgetReportOptions {
  /**
   * Report when the p95 frame exceeds the budget by this factor. A little slack
   * (default 1.25×) avoids flagging the occasional unavoidable frame while still
   * catching sustained jank. Must be ≥ 1.
   */
  p95BudgetFactor?: number;
  /** Report when at least this fraction of frames were dropped (default 0.1). */
  droppedFrameRatio?: number;
  /** Report when any long task is observed (default true). */
  reportOnLongTask?: boolean;
}

/**
 * Whether a window's summary is bad enough to surface (HUD highlight / telemetry
 * event). Kept separate from the math so the threshold policy is testable and
 * the HUD and a KPI spec can apply the same rule.
 */
export function shouldReportFrameBudget(
  summary: FrameBudgetSummary,
  options: FrameBudgetReportOptions = {},
): boolean {
  if (summary.sampleCount === 0) return false;
  const p95Factor = Math.max(1, options.p95BudgetFactor ?? 1.25);
  const droppedRatio = options.droppedFrameRatio ?? 0.1;
  const reportOnLongTask = options.reportOnLongTask ?? true;

  if (reportOnLongTask && summary.longTasks > 0) return true;
  if (summary.p95FrameMs > summary.budgetMs * p95Factor) return true;
  return summary.droppedFrames / summary.sampleCount >= droppedRatio;
}

/** Telemetry payload emitted on the shared RENDER_TELEMETRY_EVENT channel. */
export interface FrameBudgetTelemetryEvent {
  source: "frameBudget";
  severity: "info" | "error";
  summary: FrameBudgetSummary;
  windowMs: number;
  at: number;
  sequence: number;
  route?: string;
}
