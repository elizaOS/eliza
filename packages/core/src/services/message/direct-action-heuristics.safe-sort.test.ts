/**
 * Regression coverage for chronological continuation ordering in
 * resolveExplicitContinuationRequestText (direct-action-heuristics.ts:2250).
 *
 * The approval path must resolve to the immediately preceding assistant turn.
 * A non-finite createdAt previously returned NaN and left the ordered window
 * out of order, risking authorization of the wrong request.
 */
import { describe, expect, it } from "vitest";
import { __testCompareContinuationByCreatedAtAsc as cmp } from "./direct-action-heuristics.ts";

function entry(id: string, createdAt: number | undefined) {
  return { id, createdAt, content: { text: "x" } } as unknown as { id: string; createdAt?: number };
}

describe("direct-action-heuristics continuation ordering", () => {
  it("sorts oldest-first", () => {
    expect([...[entry("c", 30), entry("a", 10), entry("b", 20)].sort(cmp).map((e) => e.id)]).toEqual(["a", "b", "c"]);
  });
  it("treats NaN as 0 oldest", () => {
    expect([...[entry("c", 30), entry("b", Number.NaN), entry("a", 10)].sort(cmp).map((e) => e.id)]).toEqual(["b", "a", "c"]);
  });
  it("breaks ties by id", () => {
    expect([...[entry("b", 10), entry("a", 10)].sort(cmp).map((e) => e.id)]).toEqual(["a", "b"]);
  });
});
