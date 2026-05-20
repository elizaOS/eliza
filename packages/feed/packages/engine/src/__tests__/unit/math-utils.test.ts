/**
 * Math Utilities Unit Tests
 *
 * Tests for centralized math operations in the engine package.
 */

import { describe, expect, test } from "bun:test";
import {
  clamp,
  clamp01,
  clampPercent,
  clampSentiment,
  inRange,
  lerp,
  normalize,
  percentChange,
  roundTo,
  safeDivide,
} from "../../utils/math-utils";

describe("Math Utilities", () => {
  describe("clamp", () => {
    test("clamps value above max to max", () => {
      expect(clamp(150, 0, 100)).toBe(100);
    });

    test("clamps value below min to min", () => {
      expect(clamp(-10, 0, 100)).toBe(0);
    });

    test("returns value within range unchanged", () => {
      expect(clamp(50, 0, 100)).toBe(50);
    });

    test("handles value equal to min", () => {
      expect(clamp(0, 0, 100)).toBe(0);
    });

    test("handles value equal to max", () => {
      expect(clamp(100, 0, 100)).toBe(100);
    });

    test("handles negative ranges", () => {
      expect(clamp(-50, -100, -10)).toBe(-50);
      expect(clamp(0, -100, -10)).toBe(-10);
      expect(clamp(-150, -100, -10)).toBe(-100);
    });

    test("handles decimal values", () => {
      expect(clamp(0.5, 0, 1)).toBe(0.5);
      expect(clamp(1.5, 0, 1)).toBe(1);
    });
  });

  describe("clamp01", () => {
    test("clamps to [0, 1] range", () => {
      expect(clamp01(-0.5)).toBe(0);
      expect(clamp01(0.5)).toBe(0.5);
      expect(clamp01(1.5)).toBe(1);
    });

    test("boundary values are preserved", () => {
      expect(clamp01(0)).toBe(0);
      expect(clamp01(1)).toBe(1);
    });
  });

  describe("clampPercent", () => {
    test("clamps to [0, 100] range", () => {
      expect(clampPercent(-10)).toBe(0);
      expect(clampPercent(50)).toBe(50);
      expect(clampPercent(150)).toBe(100);
    });

    test("boundary values are preserved", () => {
      expect(clampPercent(0)).toBe(0);
      expect(clampPercent(100)).toBe(100);
    });
  });

  describe("clampSentiment", () => {
    test("clamps to [-1, 1] range", () => {
      expect(clampSentiment(-2)).toBe(-1);
      expect(clampSentiment(0)).toBe(0);
      expect(clampSentiment(2)).toBe(1);
    });

    test("boundary values are preserved", () => {
      expect(clampSentiment(-1)).toBe(-1);
      expect(clampSentiment(1)).toBe(1);
    });
  });

  describe("lerp", () => {
    test("interpolates correctly at t=0", () => {
      expect(lerp(0, 100, 0)).toBe(0);
    });

    test("interpolates correctly at t=1", () => {
      expect(lerp(0, 100, 1)).toBe(100);
    });

    test("interpolates correctly at t=0.5", () => {
      expect(lerp(0, 100, 0.5)).toBe(50);
    });

    test("clamps t to [0, 1]", () => {
      expect(lerp(0, 100, -0.5)).toBe(0);
      expect(lerp(0, 100, 1.5)).toBe(100);
    });

    test("handles negative ranges", () => {
      expect(lerp(-100, 100, 0.5)).toBe(0);
    });

    test("handles reversed ranges", () => {
      expect(lerp(100, 0, 0.5)).toBe(50);
    });
  });

  describe("roundTo", () => {
    test("rounds to specified decimal places", () => {
      expect(roundTo(Math.PI, 2)).toBe(3.14);
      expect(roundTo(Math.PI, 3)).toBe(Math.PI);
      expect(roundTo(Math.PI, 0)).toBe(3);
    });

    test("defaults to 2 decimal places", () => {
      expect(roundTo(Math.PI)).toBe(3.14);
    });

    test("handles rounding up", () => {
      expect(roundTo(3.145, 2)).toBe(3.15);
    });

    test("handles negative numbers", () => {
      expect(roundTo(-Math.PI, 2)).toBe(-3.14);
    });

    test("throws RangeError for negative decimals", () => {
      expect(() => roundTo(Math.PI, -1)).toThrow(RangeError);
    });

    test("throws RangeError for non-integer decimals", () => {
      expect(() => roundTo(Math.PI, 1.5)).toThrow(RangeError);
    });
  });

  describe("percentChange", () => {
    test("calculates positive percentage change", () => {
      expect(percentChange(100, 150)).toBe(50);
    });

    test("calculates negative percentage change", () => {
      expect(percentChange(100, 50)).toBe(-50);
    });

    test("returns 0 for no change", () => {
      expect(percentChange(100, 100)).toBe(0);
    });

    test("returns 0 when both values are 0", () => {
      expect(percentChange(0, 0)).toBe(0);
    });

    test("returns 100 when original is 0 and current is non-zero", () => {
      expect(percentChange(0, 50)).toBe(100);
    });

    test("handles negative original values", () => {
      expect(percentChange(-100, -50)).toBe(50);
    });
  });

  describe("normalize", () => {
    test("normalizes value to [0, 1] by default", () => {
      expect(normalize(50, 0, 100)).toBe(0.5);
      expect(normalize(0, 0, 100)).toBe(0);
      expect(normalize(100, 0, 100)).toBe(1);
    });

    test("normalizes to custom range", () => {
      expect(normalize(50, 0, 100, 0, 10)).toBe(5);
    });

    test("extrapolates by default when value is outside range", () => {
      expect(normalize(150, 0, 100)).toBe(1.5);
      expect(normalize(-50, 0, 100)).toBe(-0.5);
    });

    test("clamps when shouldClamp is true", () => {
      expect(normalize(150, 0, 100, 0, 1, true)).toBe(1);
      expect(normalize(-50, 0, 100, 0, 1, true)).toBe(0);
    });

    test("returns toMin when fromMin equals fromMax", () => {
      expect(normalize(50, 100, 100, 0, 10)).toBe(0);
    });
  });

  describe("inRange", () => {
    test("returns true for value within range", () => {
      expect(inRange(50, 0, 100)).toBe(true);
    });

    test("returns true for value at min boundary", () => {
      expect(inRange(0, 0, 100)).toBe(true);
    });

    test("returns true for value at max boundary", () => {
      expect(inRange(100, 0, 100)).toBe(true);
    });

    test("returns false for value below range", () => {
      expect(inRange(-1, 0, 100)).toBe(false);
    });

    test("returns false for value above range", () => {
      expect(inRange(101, 0, 100)).toBe(false);
    });
  });

  describe("safeDivide", () => {
    test("divides normally for non-zero denominator", () => {
      expect(safeDivide(10, 2)).toBe(5);
    });

    test("returns 0 for zero denominator by default", () => {
      expect(safeDivide(10, 0)).toBe(0);
    });

    test("returns custom fallback for zero denominator", () => {
      expect(safeDivide(10, 0, -1)).toBe(-1);
    });

    test("handles negative values", () => {
      expect(safeDivide(-10, 2)).toBe(-5);
      expect(safeDivide(10, -2)).toBe(-5);
    });

    test("handles decimal values", () => {
      expect(safeDivide(1, 3)).toBeCloseTo(0.333, 2);
    });
  });
});
