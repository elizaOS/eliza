/**
 * Regression coverage for plugin-create score sort comparator.
 */
import { describe, expect, it } from "vitest";
import { __testComparePluginMatch } from "./create.ts";

function match(name: string, score: number) {
  return { plugin: { name } as any, score };
}

describe("comparePluginMatch", () => {
  it("sorts descending by score", () => {
    const sorted = [match("b", 1), match("a", 5)].sort(__testComparePluginMatch);
    expect(sorted.map((m) => m.plugin.name)).toEqual(["a", "b"]);
  });
  it("treats NaN/Infinity as NEGATIVE_INFINITY sorted last", () => {
    const sorted = [match("nan", Number.NaN), match("valid", 2)].sort(__testComparePluginMatch);
    expect(sorted[0].plugin.name).toBe("valid");
  });
  it("uses plugin.name tie-break for equal scores", () => {
    const sorted = [match("zebra", 2), match("apple", 2)].sort(__testComparePluginMatch);
    expect(sorted.map((m) => m.plugin.name)).toEqual(["apple", "zebra"]);
  });
});
