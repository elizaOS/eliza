/**
 * Regression coverage for context-routing score sort comparator.
 */
import { describe, expect, it } from "vitest";
import { __testCompareContextScore } from "./context-routing.ts";

function entry(context: string, score: number) {
  return { context, score };
}

describe("compareContextScore", () => {
  it("sorts descending by score", () => {
    const sorted = [entry("b", 1), entry("a", 3), entry("c", 2)].sort(__testCompareContextScore);
    expect(sorted.map((e) => e.context)).toEqual(["a", "c", "b"]);
  });

  it("treats NaN/Infinity as NEGATIVE_INFINITY sorted last", () => {
    const sorted = [entry("nan", Number.NaN), entry("valid", 1), entry("inf", Number.POSITIVE_INFINITY)].sort(__testCompareContextScore);
    expect(sorted[0].context).toBe("valid");
    expect(sorted.slice(1).map((e) => e.context).sort()).toEqual(["inf", "nan"]);
  });

  it("uses context localeCompare as tie-break for equal scores", () => {
    const sorted = [entry("zebra", 2), entry("apple", 2)].sort(__testCompareContextScore);
    expect(sorted.map((e) => e.context)).toEqual(["apple", "zebra"]);
  });
});
