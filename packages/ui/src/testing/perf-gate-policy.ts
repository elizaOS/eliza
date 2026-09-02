/**
 * Defines the deterministic multi-window policy used by the shell performance
 * gate so noisy-runner tolerance cannot silently weaken its frame-loss budget.
 */

import {
  type FrameBudgetReportOptions,
  type FrameBudgetSummary,
  shouldReportFrameBudget,
} from "../hooks/frame-budget";

/**
 * Hosted-runner budget for the layout-heavy maximize/restore gesture. The
 * pull-to-maximize ↔ restore drag is a 1:1 finger-tracking integrator that
 * re-renders and re-lays out the WHOLE panel on every frame of the drag, so
 * doubling 24–40% of frames is its measured hosted-runner band, not jank — the
 * worst frame stays one dropped frame (~33.4ms), never a stall. Five independent
 * windows absorb isolated load spikes while sustained 40% loss still fails the
 * majority vote; the p95 factor remains the stall detector because a genuine
 * regression exceeds two dropped frames (~50ms p95) regardless of drop ratio.
 */
export const RELAYOUT_FRAME_GATE = {
  p95BudgetFactor: 2.5,
  droppedFrameRatio: 0.4,
  reportOnLongTask: false,
} satisfies FrameBudgetReportOptions;

/** Five windows tolerate two isolated load spikes but fail a degraded majority. */
export const RELAYOUT_FRAME_GATE_WINDOW_COUNT = 5;

export interface FrameBudgetWindowEvaluation {
  failed: boolean;
  flaggedCount: number;
  windowCount: number;
}

/**
 * Applies one frame policy to independent windows and fails when a strict
 * majority breaches it. Zero windows fail closed: an empty collection means
 * the gesture was never measured, and passing it would be the same vacuous
 * green as a skipped lane, so callers must supply at least one window.
 */
export function evaluateFrameBudgetWindows(
  summaries: readonly FrameBudgetSummary[],
  options: FrameBudgetReportOptions,
): FrameBudgetWindowEvaluation {
  const flaggedCount = summaries.filter((summary) =>
    shouldReportFrameBudget(summary, options),
  ).length;

  return {
    failed:
      summaries.length === 0 || flaggedCount > Math.floor(summaries.length / 2),
    flaggedCount,
    windowCount: summaries.length,
  };
}
