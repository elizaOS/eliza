/**
 * Regression coverage for ConnectorModeSelector priority sort comparator.
 */
import { describe, expect, it } from "vitest";
import { __testCompareConnectorModePriority } from "./ConnectorModeSelector.helpers.ts";

function mode(id: string, priority: number | undefined) {
  return { id, defaultPriority: priority };
}

describe("compareConnectorModePriority", () => {
  it("sorts ascending by priority", () => {
    const sorted = [mode("c", 30), mode("a", 10), mode("b", 20)].sort(__testCompareConnectorModePriority);
    expect(sorted.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
  it("treats NaN/undefined/Infinity as 0", () => {
    const sorted = [mode("z", Number.NaN), mode("a", undefined), mode("m", Number.POSITIVE_INFINITY), mode("b", 0)].sort(__testCompareConnectorModePriority);
    expect(sorted.map((m) => m.id)).toEqual(["a", "b", "m", "z"]);
  });
  it("uses id localeCompare as tie-break", () => {
    const sorted = [mode("zebra", 5), mode("apple", 5)].sort(__testCompareConnectorModePriority);
    expect(sorted.map((m) => m.id)).toEqual(["apple", "zebra"]);
  });
});
