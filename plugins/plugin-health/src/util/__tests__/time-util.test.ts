import { describe, expect, it } from "vitest";
import { parseIsoMs, roundConfidence } from "./time-util.ts";

describe("parseIsoMs", () => {
  it("parses valid ISO timestamps", () => {
    const ms = parseIsoMs("2026-08-24T12:00:00Z");
    expect(ms).toBe(Date.parse("2026-08-24T12:00:00Z"));
  });

  it("returns null for invalid or empty input", () => {
    expect(parseIsoMs("not-a-date")).toBeNull();
    expect(parseIsoMs("")).toBeNull();
    expect(parseIsoMs("   ")).toBeNull();
    expect(parseIsoMs(null)).toBeNull();
    expect(parseIsoMs(undefined)).toBeNull();
  });
});

describe("roundConfidence", () => {
  it("clamps to the 0-1 range and rounds to two decimals", () => {
    expect(roundConfidence(0.12345)).toBe(0.12);
    expect(roundConfidence(0.999)).toBe(1);
    expect(roundConfidence(0)).toBe(0);
    expect(roundConfidence(1)).toBe(1);
  });

  it("clamps out-of-range values", () => {
    expect(roundConfidence(1.5)).toBe(1);
    expect(roundConfidence(-0.5)).toBe(0);
  });

  it("returns 0 for non-finite input", () => {
    expect(roundConfidence(Number.NaN)).toBe(0);
    expect(roundConfidence(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
