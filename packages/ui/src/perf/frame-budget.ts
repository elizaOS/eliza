/**
 * Frame-budget measurement (#9141 gap 1).
 *
 * The dashboard targets a sustained 60fps (desktop) / 120fps (ProMotion) during
 * hot interactions, but nothing measured interaction framerate — only load-time
 * FCP/LCP and render-loop guards. This module is the measurement primitive: a
 * pure `summarizeFrames` over a window of rAF timestamps, plus a `FrameBudgetSampler`
 * that collects them. The sampler runs a rAF loop ONLY while started, so it costs
 * nothing unless a caller (the dev overlay) explicitly turns it on.
 */

/** One 60fps frame, in ms (~16.67). */
export const FRAME_BUDGET_60_MS = 1000 / 60;
/** One 120fps frame, in ms (~8.33). */
export const FRAME_BUDGET_120_MS = 1000 / 120;
/** A frame longer than budget × this is counted as dropped/janky. */
export const JANK_FACTOR = 1.5;

export interface FrameBudgetSummary {
  /** Mean frames-per-second across the window (0 when too few samples). */
  fps: number;
  /** Longest single frame in the window, ms. */
  worstFrameMs: number;
  /** Frames that exceeded `budgetMs × JANK_FACTOR` (dropped frames). */
  jankFrames: number;
  /** Number of frame timestamps in the window. */
  sampleCount: number;
}

/**
 * Summarize a window of monotonically-increasing rAF timestamps (ms) into fps +
 * jank stats. Pure: no DOM, no timers — unit-testable. Fewer than 2 samples
 * yields a zeroed summary (no interval to measure).
 */
export function summarizeFrames(
  timestamps: readonly number[],
  budgetMs: number = FRAME_BUDGET_60_MS,
): FrameBudgetSummary {
  if (timestamps.length < 2) {
    return {
      fps: 0,
      worstFrameMs: 0,
      jankFrames: 0,
      sampleCount: timestamps.length,
    };
  }

  const jankThreshold = budgetMs * JANK_FACTOR;
  let worst = 0;
  let jank = 0;
  for (let i = 1; i < timestamps.length; i++) {
    const dt = timestamps[i] - timestamps[i - 1];
    if (dt > worst) worst = dt;
    if (dt > jankThreshold) jank++;
  }

  const elapsed = timestamps[timestamps.length - 1] - timestamps[0];
  const fps = elapsed > 0 ? ((timestamps.length - 1) / elapsed) * 1000 : 0;

  return {
    fps: Math.round(fps),
    worstFrameMs: Math.round(worst * 10) / 10,
    jankFrames: jank,
    sampleCount: timestamps.length,
  };
}

type RafLike = (cb: (now: number) => void) => number;
type CancelRafLike = (handle: number) => void;

export interface FrameBudgetSamplerOptions {
  /** Max timestamps retained (rolling window). Default 120 (~1-2s at 60-120fps). */
  windowSize?: number;
  /** Budget for jank classification. Default 60fps. */
  budgetMs?: number;
  /** Injectable for tests; defaults to requestAnimationFrame. */
  raf?: RafLike;
  cancelRaf?: CancelRafLike;
  now?: () => number;
}

/**
 * Collects rAF frame timestamps into a rolling window. Inert until `start()`;
 * `stop()` cancels the loop. Single source for the dev overlay's live readout.
 */
export class FrameBudgetSampler {
  private readonly windowSize: number;
  private readonly budgetMs: number;
  private readonly raf: RafLike;
  private readonly cancelRaf: CancelRafLike;
  private frames: number[] = [];
  private handle: number | null = null;

  constructor(options: FrameBudgetSamplerOptions = {}) {
    this.windowSize = Math.max(2, options.windowSize ?? 120);
    this.budgetMs = options.budgetMs ?? FRAME_BUDGET_60_MS;
    this.raf =
      options.raf ??
      ((cb) =>
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(cb)
          : 0);
    this.cancelRaf =
      options.cancelRaf ??
      ((h) => {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(h);
      });
  }

  get running(): boolean {
    return this.handle !== null;
  }

  /** Record one frame timestamp (exposed for tests; the loop calls it). */
  push(timestamp: number): void {
    this.frames.push(timestamp);
    if (this.frames.length > this.windowSize) {
      this.frames.splice(0, this.frames.length - this.windowSize);
    }
  }

  summary(): FrameBudgetSummary {
    return summarizeFrames(this.frames, this.budgetMs);
  }

  start(): void {
    if (this.handle !== null) return;
    const tick = (now: number) => {
      this.push(now);
      this.handle = this.raf(tick);
    };
    this.handle = this.raf(tick);
  }

  stop(): void {
    if (this.handle !== null) {
      this.cancelRaf(this.handle);
      this.handle = null;
    }
  }

  reset(): void {
    this.frames = [];
  }
}
