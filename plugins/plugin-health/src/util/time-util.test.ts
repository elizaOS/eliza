/**
 * Covers the tiny time-parsing helpers shared across LifeOps layers.
 * Pins ISO-to-ms conversion, blank handling, and confidence clamping so
 * malformed timestamps never propagate as NaN and confidence never leaves 0-1.
 */
import { describe, expect, it } from "vitest";

import { parseIsoMs, roundConfidence } from "./time-util";

describe("parseIsoMs", () => {
  it("parses valid ISO timestamps to milliseconds", () => {
    expect(parseIsoMs("2024-01-01T00:00:00.000Z")).toBe(
      Date.parse("2024-01-01T00:00:00.000Z"),
    );
    expect(parseIsoMs("2024-06-15T12:34:56Z")).toBe(
      Date.parse("2024-06-15T12:34:56Z"),
    );
    expect(parseIsoMs("2024-01-01")).toBe(Date.parse("2024-01-01"));
  });

  it("returns null for null, undefined, and blank inputs", () => {
    expect(parseIsoMs(null)).toBeNull();
    expect(parseIsoMs(undefined)).toBeNull();
    expect(parseIsoMs("")).toBeNull();
    expect(parseIsoMs("   ")).toBeNull();
    expect(parseIsoMs("\t\n")).toBeNull();
  });

  it("returns null for malformed timestamps", () => {
    expect(parseIsoMs("not-a-date")).toBeNull();
    expect(parseIsoMs("2024-13-01T00:00:00Z")).toBeNull();
  });

  it("returns a timestamp for out-of-range calendar dates that Date.parse rolls over", () => {
    // Date.parse rolls Feb 30 to Mar 1; the helper does not validate calendar,
    // it only checks isFinite, so this is a known leniency.
    expect(parseIsoMs("2024-02-30T00:00:00Z")).toBe(
      Date.parse("2024-02-30T00:00:00Z"),
    );
    expect(parseIsoMs("2024-02-30T00:00:00Z")).not.toBeNull();
  });

  it("does not trim before parsing, so whitespace-wrapped ISO returns null", () => {
    expect(parseIsoMs("  2024-01-01T00:00:00.000Z  ")).toBeNull();
  });

  it("returns null for non-string non-null inputs treated as blank", () => {
    // @ts-expect-error intentional misuse
    expect(parseIsoMs(123)).toBeNull();
    // @ts-expect-error intentional misuse
    expect(parseIsoMs({})).toBeNull();
  });
});

describe("roundConfidence", () => {
  it("clamps below 0 to 0 and above 1 to 1", () => {
    expect(roundConfidence(-0.5)).toBe(0);
    expect(roundConfidence(-100)).toBe(0);
    expect(roundConfidence(1.5)).toBe(1);
    expect(roundConfidence(100)).toBe(1);
  });

  it("rounds to two decimals", () => {
    expect(roundConfidence(0.1234)).toBe(0.12);
    expect(roundConfidence(0.126)).toBe(0.13);
    expect(roundConfidence(0.005)).toBe(0.01);
    expect(roundConfidence(0.004)).toBe(0);
    expect(roundConfidence(0.999)).toBe(1);
  });

  it("returns 0 for non-finite inputs", () => {
    expect(roundConfidence(Number.NaN)).toBe(0);
    expect(roundConfidence(Number.POSITIVE_INFINITY)).toBe(0);
    expect(roundConfidence(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("preserves exact 0 and 1", () => {
    expect(roundConfidence(0)).toBe(0);
    expect(roundConfidence(1)).toBe(1);
    expect(roundConfidence(0.5)).toBe(0.5);
  });
});
