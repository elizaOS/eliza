/**
 * Boundary tests for the shared scheduling Date-range projection helpers.
 * The cases are deterministic and exercise exact JS Date limits plus hostile
 * connector/contributor minute offsets without invoking the runner.
 */

import { describe, expect, it } from "vitest";

import {
  isRepresentableMs,
  MAX_DATE_MS,
  projectMinuteOffsetMs,
} from "./time-range.js";

describe("scheduling Date-range projection", () => {
  it("accepts both exact Date bounds and rejects every non-representable value", () => {
    expect(isRepresentableMs(MAX_DATE_MS)).toBe(true);
    expect(isRepresentableMs(-MAX_DATE_MS)).toBe(true);
    expect(isRepresentableMs(MAX_DATE_MS + 1)).toBe(false);
    expect(isRepresentableMs(-MAX_DATE_MS - 1)).toBe(false);
    expect(isRepresentableMs(Number.NaN)).toBe(false);
    expect(isRepresentableMs(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isRepresentableMs(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it("projects exact-bound offsets while rejecting negative and non-finite minutes", () => {
    expect(projectMinuteOffsetMs(MAX_DATE_MS - 60_000, 1)).toBe(MAX_DATE_MS);
    expect(projectMinuteOffsetMs(MAX_DATE_MS, 0)).toBe(MAX_DATE_MS);
    expect(projectMinuteOffsetMs(MAX_DATE_MS, 1)).toBeNull();
    expect(projectMinuteOffsetMs(0, -1)).toBeNull();
    expect(projectMinuteOffsetMs(0, Number.NaN)).toBeNull();
    expect(projectMinuteOffsetMs(0, Number.POSITIVE_INFINITY)).toBeNull();
    expect(projectMinuteOffsetMs(Number.NaN, 1)).toBeNull();
  });
});
