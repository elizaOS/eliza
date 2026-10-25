/**
 * Frame-budget measurement for the dashboard shell (issue #9141, task 1).
 *
 * The render-telemetry stack (useRenderGuard / RenderTelemetryProfiler) detects
 * runaway *render loops* — too many React commits per second. It says nothing
 * about *dropped frames*: a single expensive layout/paint or a main-thread long
 * task blows the 60/120fps budget without ever tripping a commit-rate threshold.
 * This module is the missing measurement — a pure summarizer over a window of
 * requestAnimationFrame deltas plus PerformanceObserver('longtask') counts, so
 * the live HUD and any KPI spec can read the same numbers from the same math.
 *
 * Everything here is pure and deterministic (no rAF, no DOM) so it unit-tests
 * cleanly; the rAF/observer glue lives in ./useFrameBudgetMonitor.
 */

/** A frame-rate target. 60 → a 16.67ms budget; 120 → 8.33ms (ProMotion). */
export interface FrameBudget {
  targetFps: number;
}

export const DEFAULT_FRAME_BUDGET: FrameBudget = { targetFps: 60 };
const DROPPED_FRAME_EPSILON_FACTOR = 1.05;

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
  const droppedFrames = samples.filter(
    (delta) => delta > budgetMs * DROPPED_FRAME_EPSILON_FACTOR,
  ).length;

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

type RafLike = (cb: (now: number) => void) => number;
type CancelRafLike = (handle: number) => void;

export interface FrameBudgetSamplerOptions {
  /** Max frame deltas retained in the rolling window. Default 120 (~1-2s). */
  windowSize?: number;
  /** Frame-rate target used by `summary()`. Default 60fps. */
  budget?: FrameBudget;
  /** Injectable rAF for tests; defaults to `requestAnimationFrame`. */
  raf?: RafLike;
  /** Injectable cancel for tests; defaults to `cancelAnimationFrame`. */
  cancelRaf?: CancelRafLike;
  /**
   * Called on every sampled frame with the running sampler. The dev HUD polls
   * `summary()` on an interval; the telemetry monitor uses this to flush + reset
   * on a fixed time window. Kept optional so the sampler stays a pure collector.
   */
  onFrame?: (timestamp: number, sampler: FrameBudgetSampler) => void;
  /**
   * Observe `PerformanceObserver('longtask')` entries while running (default
   * true). Long tasks block the main thread past a frame budget without ever
   * showing up as a slow rAF delta, so they are a first-class budget signal.
   */
  observeLongTasks?: boolean;
}

/**
 * The single rAF + longtask collector for the dashboard's frame-budget tooling.
 * It records inter-frame deltas into a bounded rolling window and counts long
 * tasks; `summary()` reduces them through {@link summarizeFrameSamples} so the
 * dev overlay and the telemetry monitor read identical math. Inert until
 * `start()`, so it costs nothing unless a caller explicitly turns it on.
 *
 * Pure except for the rAF/observer glue (both injectable), so it unit-tests by
 * driving the injected rAF callback directly.
 */
export class FrameBudgetSampler {
  private readonly windowSize: number;
  private readonly budget: FrameBudget;
  private readonly raf: RafLike;
  private readonly cancelRaf: CancelRafLike;
  private readonly onFrame?: (
    timestamp: number,
    sampler: FrameBudgetSampler,
  ) => void;
  private readonly observeLongTasks: boolean;
  private deltas: number[] = [];
  private lastTimestamp: number | null = null;
  private longTaskCount = 0;
  private handle: number | null = null;
  private observer: PerformanceObserver | null = null;

  constructor(options: FrameBudgetSamplerOptions = {}) {
    this.windowSize = Math.max(1, options.windowSize ?? 120);
    this.budget = options.budget ?? DEFAULT_FRAME_BUDGET;
    this.onFrame = options.onFrame;
    this.observeLongTasks = options.observeLongTasks ?? true;
    this.raf =
      options.raf ??
      ((cb) =>
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(cb)
          : 0);
    this.cancelRaf =
      options.cancelRaf ??
      ((handle) => {
        if (typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(handle);
        }
      });
  }

  get running(): boolean {
    return this.handle !== null;
  }

  get longTasks(): number {
    return this.longTaskCount;
  }

  /** Record one frame timestamp (ms). The first sample only seeds the baseline. */
  push(timestamp: number): void {
    if (this.lastTimestamp !== null) {
      this.deltas.push(timestamp - this.lastTimestamp);
      if (this.deltas.length > this.windowSize) {
        this.deltas.splice(0, this.deltas.length - this.windowSize);
      }
    }
    this.lastTimestamp = timestamp;
  }

  summary(): FrameBudgetSummary {
    return summarizeFrameSamples(this.deltas, this.longTaskCount, this.budget);
  }

  start(): void {
    if (this.handle !== null) return;
    if (this.observeLongTasks && typeof PerformanceObserver === "function") {
      try {
        this.observer = new PerformanceObserver((list) => {
          this.longTaskCount += list.getEntries().length;
        });
        this.observer.observe({ entryTypes: ["longtask"] });
      } catch {
        // `longtask` is unsupported in some engines (notably Safari) — feature
        // detection at the boundary; frame deltas still measure framerate.
        this.observer = null;
      }
    }
    const tick = (now: number) => {
      this.push(now);
      this.onFrame?.(now, this);
      this.handle = this.raf(tick);
    };
    this.handle = this.raf(tick);
  }

  stop(): void {
    if (this.handle !== null) {
      this.cancelRaf(this.handle);
      this.handle = null;
    }
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Clear the rolling window and long-task count (start of a new time window). */
  reset(): void {
    this.deltas = [];
    this.lastTimestamp = null;
    this.longTaskCount = 0;
  }
}

/**
 * Browser-side init script (for `page.addInitScript` / `page.evaluate`) that
 * records RAW inter-frame `requestAnimationFrame` deltas plus
 * `PerformanceObserver('longtask')` entries while `window.__ELIZA_FRAME` is
 * sampling. Mirrors {@link LAYOUT_SHIFT_OBSERVER_INIT} in layout-stability.ts:
 * it collects RAW entries only — the Node caller feeds them to
 * {@link summarizeFrameSamples} / {@link shouldReportFrameBudget}, so the gate
 * applies the exact same math the live HUD does.
 *
 * `start()` resets the buffers and (re)installs the longtask observer, so each
 * gesture window is measured in isolation; `read()` returns a snapshot
 * (`{ deltas, longTasks }`); `stop()` halts sampling. `longtask` is unsupported
 * in some engines (notably Safari) — feature-detected at the boundary, so the
 * deltas still measure framerate there with a long-task count of 0.
 *
 * Co-located with the pure math (exactly how LAYOUT_SHIFT_OBSERVER_INIT sits
 * beside summarizeStability) and inert until a caller injects it — zero prod cost.
 */
export const FRAME_SAMPLER_INIT = `
(() => {
  const w = window;
  if (w.__ELIZA_FRAME) return;
  let deltas = [];
  let longTasks = 0;
  let last = null;
  let raf = null;
  let obs = null;
  const tick = (now) => {
    if (last !== null) deltas.push(now - last);
    last = now;
    raf = requestAnimationFrame(tick);
  };
  w.__ELIZA_FRAME = {
    start() {
      deltas = [];
      longTasks = 0;
      last = null;
      try {
        obs = new PerformanceObserver((list) => {
          longTasks += list.getEntries().length;
        });
        obs.observe({ entryTypes: ['longtask'] });
      } catch {
        obs = null;
      }
      if (raf === null) raf = requestAnimationFrame(tick);
    },
    stop() {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      if (obs) {
        obs.disconnect();
        obs = null;
      }
    },
    read() {
      return { deltas: deltas.slice(), longTasks };
    },
  };
})();
`;
