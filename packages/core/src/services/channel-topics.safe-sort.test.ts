/**
 * Regression coverage for channel-topics score sort comparator.
 */
import { describe, expect, it } from "vitest";
import { __testCompareTopicScore } from "./channel-topics.ts";

function hit(roomId: string, score: number) {
  return { roomId, score };
}

describe("compareTopicScore", () => {
  it("sorts descending by score", () => {
    const sorted = [hit("b", 1), hit("a", 5), hit("c", 3)].sort(__testCompareTopicScore);
    expect(sorted.map((h) => h.roomId)).toEqual(["a", "c", "b"]);
  });

  it("treats NaN/Infinity as NEGATIVE_INFINITY sorted last", () => {
    const sorted = [hit("nan", Number.NaN), hit("valid", 2), hit("inf", Number.POSITIVE_INFINITY)].sort(__testCompareTopicScore);
    expect(sorted[0].roomId).toBe("valid");
    expect(sorted.slice(1).map((h) => h.roomId).sort()).toEqual(["inf", "nan"]);
  });

  it("uses roomId localeCompare as tie-break for equal scores", () => {
    const sorted = [hit("zebra", 2), hit("apple", 2)].sort(__testCompareTopicScore);
    expect(sorted.map((h) => h.roomId)).toEqual(["apple", "zebra"]);
  });
});
