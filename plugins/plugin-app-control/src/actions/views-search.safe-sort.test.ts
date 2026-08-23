/**
 * Regression coverage for views-search score sort comparator.
 */
import { describe, expect, it } from "vitest";
import { __testCompareScoredView } from "./views-search.ts";

function scored(id: string, score: number) {
  return { view: { id } as any, score };
}

describe("compareScoredView", () => {
  it("sorts descending by score", () => {
    const sorted = [scored("b", 10), scored("a", 80), scored("c", 40)].sort(__testCompareScoredView);
    expect(sorted.map((s) => s.view.id)).toEqual(["a", "c", "b"]);
  });

  it("treats NaN/Infinity as NEGATIVE_INFINITY sorted last", () => {
    const sorted = [scored("nan", Number.NaN), scored("inf", Number.POSITIVE_INFINITY), scored("valid", 5)].sort(__testCompareScoredView);
    expect(sorted[0].view.id).toBe("valid");
    expect(sorted.slice(1).map((s) => s.view.id).sort()).toEqual(["inf", "nan"]);
  });

  it("uses view.id localeCompare as tie-break for equal scores", () => {
    const sorted = [scored("zebra", 10), scored("apple", 10)].sort(__testCompareScoredView);
    expect(sorted.map((s) => s.view.id)).toEqual(["apple", "zebra"]);
  });
});
