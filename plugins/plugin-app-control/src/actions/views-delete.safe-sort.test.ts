/**
 * Regression coverage for views-delete score sort comparator.
 */
import { describe, expect, it } from "vitest";
import { __testCompareScoredDeleteView } from "./views-delete.ts";

function scored(id: string, score: number) {
  return { view: { id } as any, score };
}

describe("compareScoredDeleteView", () => {
  it("sorts descending by score", () => {
    const sorted = [scored("b", 10), scored("a", 80)].sort(__testCompareScoredDeleteView);
    expect(sorted.map((s) => s.view.id)).toEqual(["a", "b"]);
  });
  it("treats NaN/Infinity as NEGATIVE_INFINITY sorted last", () => {
    const sorted = [scored("nan", Number.NaN), scored("valid", 5)].sort(__testCompareScoredDeleteView);
    expect(sorted[0].view.id).toBe("valid");
  });
  it("uses view.id tie-break for equal scores", () => {
    const sorted = [scored("zebra", 10), scored("apple", 10)].sort(__testCompareScoredDeleteView);
    expect(sorted.map((s) => s.view.id)).toEqual(["apple", "zebra"]);
  });
});
