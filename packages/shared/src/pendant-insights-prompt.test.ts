import { describe, expect, it } from "vitest";
import {
  buildInsightsPrompt,
  computeTranscriptRange,
  makeSourceSegment,
  renderTranscriptForPrompt,
} from "./pendant-insights-prompt.js";

describe("pendant insights prompt", () => {
  const segments = [
    makeSourceSegment({
      sessionId: "meeting",
      ordinal: 0,
      text: "oldest",
      atMs: 10,
    }),
    makeSourceSegment({
      sessionId: "meeting",
      ordinal: 1,
      text: "middle",
      atMs: 20,
    }),
    makeSourceSegment({
      sessionId: "meeting",
      ordinal: 2,
      text: "newest",
      atMs: 30,
    }),
  ];

  it("keeps the newest complete segments under the rolling character budget", () => {
    const oneLineBudget = `[${segments[2].id}] newest`.length;
    const rendered = renderTranscriptForPrompt(segments, oneLineBudget);
    expect(rendered.included.map((segment) => segment.ordinal)).toEqual([2]);
    expect(rendered.body).toContain("newest");
    expect(rendered.body).not.toContain("oldest");
  });

  it("computes the audited ordinal and timestamp range", () => {
    expect(computeTranscriptRange([segments[2], segments[1]])).toEqual({
      startOrdinal: 1,
      endOrdinal: 2,
      segmentCount: 2,
      startedAtMs: 20,
      endedAtMs: 30,
    });
  });

  it("includes prior context as continuity-only and exposes included ids", () => {
    const built = buildInsightsPrompt({
      segments,
      priorSummary: "Earlier summary",
    });
    expect(built.prompt).toContain("Earlier summary");
    expect(built.prompt).toContain("do NOT re-report it");
    expect(built.includedSegmentIds).toEqual(
      segments.map((segment) => segment.id),
    );
    expect(built.transcriptRange.segmentCount).toBe(3);
  });
});
