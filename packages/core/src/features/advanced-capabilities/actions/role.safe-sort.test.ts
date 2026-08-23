/**
 * Regression coverage for role score sort comparator.
 */
import { describe, expect, it } from "vitest";
import { __testCompareRoleScore } from "./role.ts";

function entry(id: string, score: number) {
  return { candidate: { entityId: id } as any, score };
}

describe("compareRoleScore", () => {
  it("sorts descending by score", () => {
    const sorted = [entry("b", 10), entry("a", 80)].sort(__testCompareRoleScore);
    expect(sorted.map((e) => e.candidate.entityId)).toEqual(["a", "b"]);
  });
  it("treats NaN/Infinity as NEGATIVE_INFINITY sorted last", () => {
    const sorted = [entry("nan", Number.NaN), entry("valid", 5)].sort(__testCompareRoleScore);
    expect(sorted[0].candidate.entityId).toBe("valid");
  });
  it("uses entityId tie-break for equal scores", () => {
    const sorted = [entry("zebra", 10), entry("apple", 10)].sort(__testCompareRoleScore);
    expect(sorted.map((e) => e.candidate.entityId)).toEqual(["apple", "zebra"]);
  });
});
