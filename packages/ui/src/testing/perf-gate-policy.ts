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
 * Hosted-runner budget for the layout-heavy maximize/restore gesture. Healthy
 * runs measure 24–30% loss; isolated spikes near 37% are absorbed by the
 * multi-window vote rather than widening this boundary past sustained 40% loss.
 */
export const RELAYOUT_FRAME_GATE = {
  p95BudgetFactor: 2.5,
  droppedFrameRatio: 0.35,
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
 * Applies one frame policy to independent windows and fails only when a strict
 * majority breaches it. An empty collection is not a performance failure; the
 * browser harness separately rejects windows without enough frame samples.
 */
export function evaluateFrameBudgetWindows(
  summaries: readonly FrameBudgetSummary[],
  options: FrameBudgetReportOptions,
): FrameBudgetWindowEvaluation {
  const flaggedCount = summaries.filter((summary) =>
    shouldReportFrameBudget(summary, options),
  ).length;

  return {
    failed: flaggedCount > Math.floor(summaries.length / 2),
    flaggedCount,
    windowCount: summaries.length,
  };
}
