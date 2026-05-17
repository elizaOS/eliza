import { describe, expect, test } from "vitest";
import { calculateCreditMarkup, DEFAULT_PLATFORM_FEE_RATE } from "./credit-markup";

describe("calculateCreditMarkup", () => {
  test("applies basic creator markup with no platform fee", () => {
    expect(calculateCreditMarkup({ baseCredits: 10, markupPercent: 25 })).toEqual({
      baseCredits: 10,
      markupCredits: 2.5,
      platformFeeCredits: 0,
      totalCredits: 12.5,
    });
  });

  test("zero markup leaves base unchanged", () => {
    expect(calculateCreditMarkup({ baseCredits: 7.5, markupPercent: 0 })).toEqual({
      baseCredits: 7.5,
      markupCredits: 0,
      platformFeeCredits: 0,
      totalCredits: 7.5,
    });
  });

  test("zero base produces zero on every field", () => {
    expect(
      calculateCreditMarkup({
        baseCredits: 0,
        markupPercent: 30,
        platformFeeRate: DEFAULT_PLATFORM_FEE_RATE,
      }),
    ).toEqual({
      baseCredits: 0,
      markupCredits: 0,
      platformFeeCredits: 0,
      totalCredits: 0,
    });
  });

  test("affiliate flow: markup + platform fee both apply to base", () => {
    // Mirrors the MCP-proxy affiliate path: creditsRequired=100, markup=15%, platform=20%.
    expect(
      calculateCreditMarkup({
        baseCredits: 100,
        markupPercent: 15,
        platformFeeRate: DEFAULT_PLATFORM_FEE_RATE,
      }),
    ).toEqual({
      baseCredits: 100,
      markupCredits: 15,
      platformFeeCredits: 20,
      totalCredits: 135,
    });
  });

  test("handles fractional markup percentages without rounding", () => {
    const result = calculateCreditMarkup({
      baseCredits: 0.005,
      markupPercent: 12.5,
    });
    expect(result.baseCredits).toBe(0.005);
    expect(result.markupCredits).toBeCloseTo(0.000625, 12);
    expect(result.platformFeeCredits).toBe(0);
    expect(result.totalCredits).toBeCloseTo(0.005625, 12);
  });

  test("preserves precision: does not round, callers format at the boundary", () => {
    // baseCredits * 0.2 produces a long float; output must match the raw math.
    const result = calculateCreditMarkup({
      baseCredits: 1,
      markupPercent: 33.333,
    });
    expect(result.markupCredits).toBe(1 * (33.333 / 100));
    expect(result.totalCredits).toBe(1 + 1 * (33.333 / 100));
  });

  test("rejects negative or non-finite inputs", () => {
    expect(() => calculateCreditMarkup({ baseCredits: -1, markupPercent: 10 })).toThrow(RangeError);
    expect(() => calculateCreditMarkup({ baseCredits: 1, markupPercent: -5 })).toThrow(RangeError);
    expect(() =>
      calculateCreditMarkup({
        baseCredits: 1,
        markupPercent: 10,
        platformFeeRate: -0.1,
      }),
    ).toThrow(RangeError);
    expect(() => calculateCreditMarkup({ baseCredits: Number.NaN, markupPercent: 10 })).toThrow(
      RangeError,
    );
    expect(() =>
      calculateCreditMarkup({
        baseCredits: 1,
        markupPercent: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(RangeError);
  });

  test("exposes the canonical platform fee rate", () => {
    expect(DEFAULT_PLATFORM_FEE_RATE).toBe(0.2);
  });
});
