import { describe, expect, it } from "bun:test";
import {
  clamp,
  clamp01,
  clampSentiment,
  inRange,
  lerp,
  normalize,
  percentChange,
  roundTo,
  safeDivide,
} from "../../engine/src/utils/math-utils";

/**
 * Engine math utilities — clamping, interpolation, normalization, and safe
 * division underpin pricing/sentiment/probability math. Edge cases (divide-by-
 * zero, zero-base percent change, out-of-range clamps) are pinned because a
 * wrong value here silently skews a market computation.
 */

describe("clamps + range", () => {
  it("clamp / clamp01 / clampSentiment / inRange", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(-0.2)).toBe(0);
    expect(clampSentiment(-9)).toBe(-1);
    expect(clampSentiment(9)).toBe(1);
    expect(inRange(5, 1, 10)).toBe(true);
    expect(inRange(0, 1, 10)).toBe(false);
  });
});

describe("lerp / roundTo", () => {
  it("interpolates with a clamped factor and rounds", () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 2)).toBe(10); // t clamped to 1
    expect(lerp(0, 10, -1)).toBe(0); // t clamped to 0
    expect(roundTo(3.14159, 2)).toBe(3.14);
    expect(roundTo(3.5, 0)).toBe(4);
    expect(() => roundTo(1, -1)).toThrow(RangeError);
  });
});

describe("percentChange / normalize / safeDivide", () => {
  it("handles zero-base percent change", () => {
    expect(percentChange(100, 150)).toBe(50);
    expect(percentChange(100, 50)).toBe(-50);
    expect(percentChange(0, 0)).toBe(0);
    expect(percentChange(0, 5)).toBe(100); // sentinel
  });

  it("normalize maps + clamps; equal range → toMin", () => {
    expect(normalize(5, 0, 10)).toBe(0.5);
    expect(normalize(5, 0, 10, 0, 100)).toBe(50);
    expect(normalize(20, 0, 10, 0, 1, true)).toBe(1); // clamped
    expect(normalize(5, 3, 3)).toBe(0); // degenerate range → toMin
  });

  it("safeDivide guards divide-by-zero", () => {
    expect(safeDivide(10, 2)).toBe(5);
    expect(safeDivide(10, 0)).toBe(0);
    expect(safeDivide(10, 0, -1)).toBe(-1);
  });
});
