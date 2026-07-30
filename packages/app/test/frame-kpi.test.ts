/**
 * Pure frame-KPI aggregation tests for the Playwright interaction gate.
 */
import { describe, expect, it } from "vitest";
import {
  FRAME_BUDGET_60_MS,
  type FrameKpiSummary,
  summarizeRepeatedFrameKpis,
} from "./ui-smoke/lib/frame-kpi";

function frameSummary(p95FrameMs: number): FrameKpiSummary {
  return {
    sampleCount: 60,
    fps: 60,
    meanFrameMs: FRAME_BUDGET_60_MS,
    p95FrameMs,
    worstFrameMs: p95FrameMs,
    droppedFrames: 0,
    longTasks: 0,
    budgetMs: FRAME_BUDGET_60_MS,
  };
}

describe("repeated frame KPI sampling", () => {
  it("reports the absolute interaction p95 on a healthy runner", () => {
    const summary = summarizeRepeatedFrameKpis([
      {
        idle: frameSummary(FRAME_BUDGET_60_MS),
        interaction: frameSummary(49),
      },
    ]);

    expect(summary.medianInteractionP95FrameMs).toBe(49);
  });

  it("does not subtract an idle-host delay from the interaction result", () => {
    const summary = summarizeRepeatedFrameKpis([
      {
        idle: frameSummary(83.4),
        interaction: frameSummary(83.4),
      },
    ]);

    expect(summary.medianInteractionP95FrameMs).toBe(83.4);
  });

  it("exposes interaction delay on a throttled runner", () => {
    const summary = summarizeRepeatedFrameKpis([
      {
        idle: frameSummary(83.4),
        interaction: frameSummary(150),
      },
    ]);

    expect(summary.medianInteractionP95FrameMs).toBe(150);
  });

  it("uses the median so one noisy window cannot pass or fail the gate", () => {
    const summary = summarizeRepeatedFrameKpis([
      {
        idle: frameSummary(16),
        interaction: frameSummary(110),
      },
      {
        idle: frameSummary(16),
        interaction: frameSummary(30),
      },
      {
        idle: frameSummary(16),
        interaction: frameSummary(31),
      },
    ]);

    expect(summary.medianInteractionP95FrameMs).toBe(31);
    expect(summary.worstInteractionP95FrameMs).toBe(110);
  });

  it("keeps a sustained interaction regression above the existing ceiling", () => {
    const summary = summarizeRepeatedFrameKpis([
      {
        idle: frameSummary(16),
        interaction: frameSummary(90),
      },
      {
        idle: frameSummary(16),
        interaction: frameSummary(91),
      },
      {
        idle: frameSummary(16),
        interaction: frameSummary(30),
      },
    ]);

    expect(summary.medianInteractionP95FrameMs).toBeGreaterThan(50);
  });

  it("rejects an empty window set instead of fabricating a healthy result", () => {
    expect(() => summarizeRepeatedFrameKpis([])).toThrow(RangeError);
  });
});
