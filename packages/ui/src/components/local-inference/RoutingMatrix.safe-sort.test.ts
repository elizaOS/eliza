/**
 * Regression coverage for RoutingMatrix priority sort comparator.
 */
import { describe, expect, it } from "vitest";
import { __testCompareRoutingPriority } from "./RoutingMatrix.tsx";

function reg(provider: string, priority: number) {
  return { provider, priority } as any;
}

describe("compareRoutingPriority", () => {
  it("sorts descending by priority", () => {
    const sorted = [reg("b", 1), reg("a", 5), reg("c", 3)].sort(__testCompareRoutingPriority);
    expect(sorted.map((r) => r.provider)).toEqual(["a", "c", "b"]);
  });
  it("treats NaN/Infinity as NEGATIVE_INFINITY sorted last", () => {
    const sorted = [reg("nan", Number.NaN), reg("valid", 2), reg("inf", Number.POSITIVE_INFINITY)].sort(__testCompareRoutingPriority);
    expect(sorted[0].provider).toBe("valid");
    expect(sorted.slice(1).map((r) => r.provider).sort()).toEqual(["inf", "nan"]);
  });
  it("uses provider localeCompare as tie-break", () => {
    const sorted = [reg("zebra", 2), reg("apple", 2)].sort(__testCompareRoutingPriority);
    expect(sorted.map((r) => r.provider)).toEqual(["apple", "zebra"]);
  });
});
