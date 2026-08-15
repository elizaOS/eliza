/**
 * Boundary coverage for getEpochMs (#18965): unit inference for seconds /
 * milliseconds / microseconds stays intact, genuinely missing values still
 * fall back to "now", and present-but-unusable values (NaN, Infinity,
 * negative) fail closed to undefined instead of masquerading as "now".
 * Deterministic via a frozen clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEpochMs } from "./time";

const NOW = 1_755_000_000_000;

describe("getEpochMs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes finite timestamps by inferred unit", () => {
    expect(getEpochMs(1_710_969_600)).toBe(1_710_969_600_000); // seconds
    expect(getEpochMs(1_710_969_600_000)).toBe(1_710_969_600_000); // millis
    expect(getEpochMs(1_710_969_600_000_000)).toBe(1_710_969_600_000); // micros
  });

  it("falls back to now for genuinely missing values", () => {
    expect(getEpochMs(undefined)).toBe(NOW);
    expect(getEpochMs(0)).toBe(NOW);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["negative", -1_710_969_600],
  ])("fails closed to undefined for %s instead of now", (_label, value) => {
    expect(getEpochMs(value)).toBeUndefined();
  });

  it("keeps fractional-second inputs (v2 conversions divide ms by 1000)", () => {
    expect(getEpochMs(1_710_969_600.123)).toBe(1_710_969_600_123);
  });
});
