/**
 * Proves the shell performance gate rejects sustained frame loss while
 * tolerating the bounded minority of noisy-runner windows it was designed for,
 * and that a run with zero measured windows fails closed rather than passing.
 */

import { describe, expect, it } from "vitest";
import { summarizeFrameSamples } from "../hooks/frame-budget";
import {
  evaluateFrameBudgetWindows,
  RELAYOUT_FRAME_GATE,
  RELAYOUT_FRAME_GATE_WINDOW_COUNT,
} from "./perf-gate-policy";

function summaryWithDroppedRatio(ratio: number) {
  const sampleCount = 100;
  const droppedFrames = Math.round(sampleCount * ratio);
  return summarizeFrameSamples([
    ...Array.from({ length: droppedFrames }, () => 20),
    ...Array.from({ length: sampleCount - droppedFrames }, () => 16),
  ]);
}

describe("maximize/restore performance-gate policy", () => {
  it("retains the hosted-runner 40% dropped-frame boundary", () => {
    expect(RELAYOUT_FRAME_GATE.droppedFrameRatio).toBe(0.4);
    expect(RELAYOUT_FRAME_GATE_WINDOW_COUNT).toBe(5);
  });

  it.each([0.4, 0.44])(
    "fails sustained %d frame loss in three of five windows",
    (droppedRatio) => {
      const degraded = summaryWithDroppedRatio(droppedRatio);
      const healthy = summaryWithDroppedRatio(0.3);

      expect(
        evaluateFrameBudgetWindows(
          [degraded, degraded, degraded, healthy, healthy],
          RELAYOUT_FRAME_GATE,
        ),
      ).toEqual({ failed: true, flaggedCount: 3, windowCount: 5 });
    },
  );

  it("fails closed on zero windows instead of passing vacuously", () => {
    expect(evaluateFrameBudgetWindows([], RELAYOUT_FRAME_GATE)).toEqual({
      failed: true,
      flaggedCount: 0,
      windowCount: 0,
    });
  });

  it("tolerates two isolated noisy windows", () => {
    const degraded = summaryWithDroppedRatio(0.4);
    const healthy = summaryWithDroppedRatio(0.3);

    expect(
      evaluateFrameBudgetWindows(
        [degraded, degraded, healthy, healthy, healthy],
        RELAYOUT_FRAME_GATE,
      ),
    ).toEqual({ failed: false, flaggedCount: 2, windowCount: 5 });
  });
});
