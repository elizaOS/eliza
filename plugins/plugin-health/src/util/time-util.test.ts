/**
 * Behavioral tests for the shared timestamp and confidence helpers used by
 * health inference and personal-assistant scheduling. The cases preserve exact
 * offset handling across DST boundaries and dependency-free browser behavior.
 */
import { describe, expect, it } from "vitest";
import { parseIsoMs, roundConfidence } from "./time-util.js";

describe("parseIsoMs", () => {
  it("preserves explicit offsets on both sides of a DST transition", () => {
    expect(parseIsoMs("2026-03-08T01:30:00-05:00")).toBe(
      Date.UTC(2026, 2, 8, 6, 30),
    );
    expect(parseIsoMs("2026-03-08T03:30:00-04:00")).toBe(
      Date.UTC(2026, 2, 8, 7, 30),
    );
  });

  it("returns null for missing, blank, and invalid input", () => {
    expect(parseIsoMs(undefined)).toBeNull();
    expect(parseIsoMs(null)).toBeNull();
    expect(parseIsoMs("   ")).toBeNull();
    expect(parseIsoMs("not-a-date")).toBeNull();
  });
});

describe("roundConfidence", () => {
  it("rounds finite values and clamps the result to the unit interval", () => {
    expect(roundConfidence(0.126)).toBe(0.13);
    expect(roundConfidence(-1)).toBe(0);
    expect(roundConfidence(2)).toBe(1);
    expect(roundConfidence(Number.NaN)).toBe(0);
  });
});
