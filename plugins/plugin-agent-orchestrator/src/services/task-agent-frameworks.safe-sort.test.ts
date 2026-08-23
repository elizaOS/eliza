/**
 * Verifies safe sorting in dominant signal extraction when signals contain NaN/Infinity.
 */

import { describe, expect, it } from "vitest";

function extractDominantSignals(signals: Record<string, number>): string[] {
  return Object.entries(signals)
    .sort((left, right) => {
      const rightVal =
        typeof right[1] === "number" && Number.isFinite(right[1])
          ? right[1]
          : 0;
      const leftVal =
        typeof left[1] === "number" && Number.isFinite(left[1]) ? left[1] : 0;
      return rightVal - leftVal || left[0].localeCompare(right[0]);
    })
    .slice(0, 2)
    .map(([key]) => key);
}

describe("task-agent-frameworks dominant signals safe sort", () => {
  it("sorts dominant signals descending and excludes NaN signals from top positions", () => {
    const signals: Record<string, number> = {
      bugfix: Number.NaN,
      refactor: 8,
      feature: 12,
    };

    const dominant = extractDominantSignals(signals);
    expect(dominant).toEqual(["feature", "refactor"]);
  });

  it("breaks ties deterministically by signal key when scores match", () => {
    const signals: Record<string, number> = {
      testing: 10,
      documentation: 10,
    };

    const dominant = extractDominantSignals(signals);
    expect(dominant).toEqual(["documentation", "testing"]);
  });
});
