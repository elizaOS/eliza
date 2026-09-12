/**
 * Unit tests for lifeops service helper sort comparators and reminder builders.
 */
import { describe, expect, it } from "vitest";
import { sortOverviewOccurrences } from "../service-helpers-misc.js";
import { parseOffsetToken } from "../time.js";
import type { LifeOpsOccurrenceView } from "../types.js";

describe("LifeOps service helpers sorting", () => {
  it("maintains strict total ordering when relevanceStartAt contains invalid dates", () => {
    const occurrences: LifeOpsOccurrenceView[] = [
      {
        id: "occ-1",
        definitionId: "def-1",
        title: "Occurrence 1",
        state: "pending",
        relevanceStartAt: "2026-05-01T10:00:00.000Z",
        priority: 1,
      } as LifeOpsOccurrenceView,
      {
        id: "occ-invalid",
        definitionId: "def-2",
        title: "Occurrence Invalid",
        state: "pending",
        relevanceStartAt: "invalid-date-string",
        priority: 2,
      } as LifeOpsOccurrenceView,
      {
        id: "occ-2",
        definitionId: "def-3",
        title: "Occurrence 2",
        state: "pending",
        relevanceStartAt: "2026-05-02T10:00:00.000Z",
        priority: 1,
      } as LifeOpsOccurrenceView,
    ];

    const sorted = sortOverviewOccurrences(occurrences);
    expect(sorted).toHaveLength(3);
    expect(sorted[0]?.id).toBe("occ-invalid"); // fallback 0 time
    expect(sorted[1]?.id).toBe("occ-1");
    expect(sorted[2]?.id).toBe("occ-2");
  });
});

describe("parseOffsetToken", () => {
  it("parses offset tokens including Unicode minus signs and UTC formats", () => {
    expect(parseOffsetToken("GMT\u22127")).toBe(-420);
    expect(parseOffsetToken("UTC-5")).toBe(-300);
    expect(parseOffsetToken("-07:00")).toBe(-420);
    expect(parseOffsetToken("GMT+02:00")).toBe(120);
    expect(parseOffsetToken("GMT-5")).toBe(-300);
  });
});
