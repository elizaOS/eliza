import { describe, expect, it } from "vitest";
import {
  applyMarkup,
  applyMarkupCents,
  calculateTwilioSmsBilling,
  DEFAULT_MARKUP_RATE,
  estimateTwilioSmsSegments,
} from "../markup";

describe("applyMarkup", () => {
  it("applies the default 20% markup to a whole-dollar cost", () => {
    const result = applyMarkup(1.0);
    expect(result).toEqual({
      rawCost: 1.0,
      markup: 0.2,
      billedCost: 1.2,
      markupRate: DEFAULT_MARKUP_RATE,
    });
  });

  it("returns zero for zero cost", () => {
    expect(applyMarkup(0)).toEqual({
      rawCost: 0,
      markup: 0,
      billedCost: 0,
      markupRate: DEFAULT_MARKUP_RATE,
    });
  });

  it("rounds to whole cents (half-up) to avoid float drift", () => {
    // 0.01 * 1.20 = 0.012 -> billed 0.01, markup 0 (< 0.5 cents rounds down).
    const result = applyMarkup(0.01);
    expect(result.rawCost).toBe(0.01);
    expect(result.billedCost).toBe(0.01);
    expect(result.markup).toBe(0);
  });

  it("handles large SMS-bulk floating point inputs without drift", () => {
    // 0.0075 * 10_000 messages = 75.00 raw, 90.00 billed.
    const result = applyMarkup(0.0075 * 10_000);
    expect(result.rawCost).toBeCloseTo(75.0, 10);
    expect(result.billedCost).toBeCloseTo(90.0, 10);
    expect(result.markup).toBeCloseTo(15.0, 10);
  });

  it("supports a custom markup rate", () => {
    const result = applyMarkup(5.0, 0.1);
    expect(result).toEqual({
      rawCost: 5.0,
      markup: 0.5,
      billedCost: 5.5,
      markupRate: 0.1,
    });
  });

  it("supports a zero markup rate (pure passthrough)", () => {
    const result = applyMarkup(2.34, 0);
    expect(result.rawCost).toBe(2.34);
    expect(result.markup).toBe(0);
    expect(result.billedCost).toBe(2.34);
  });

  it("rejects negative costs", () => {
    expect(() => applyMarkup(-0.01)).toThrow(RangeError);
  });

  it("rejects negative markup rates", () => {
    expect(() => applyMarkup(1.0, -0.2)).toThrow(RangeError);
  });

  it("rejects non-finite inputs", () => {
    expect(() => applyMarkup(Number.NaN)).toThrow(RangeError);
    expect(() => applyMarkup(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => applyMarkup(1.0, Number.NaN)).toThrow(RangeError);
  });
});

describe("applyMarkupCents", () => {
  it("applies 20% markup on integer cents", () => {
    expect(applyMarkupCents(100)).toBe(120);
    expect(applyMarkupCents(250)).toBe(300);
  });

  it("rounds half-up to the nearest cent", () => {
    // 1 cent * 1.2 = 1.2 -> rounds to 1 cent
    expect(applyMarkupCents(1)).toBe(1);
    // 3 cents * 1.2 = 3.6 -> rounds to 4 cents
    expect(applyMarkupCents(3)).toBe(4);
  });

  it("preserves zero and rejects non-integer / negative inputs", () => {
    expect(applyMarkupCents(0)).toBe(0);
    expect(() => applyMarkupCents(1.5)).toThrow(RangeError);
    expect(() => applyMarkupCents(-1)).toThrow(RangeError);
  });
});

describe("Twilio SMS billing", () => {
  it("calculates 20% markup for a multi-segment SMS body", () => {
    const body = "x".repeat(481);
    const segments = estimateTwilioSmsSegments(body);
    expect(segments).toBe(4);

    const billing = calculateTwilioSmsBilling(body, 0.0075);
    expect(billing).toEqual({
      rawCost: 0.03,
      markup: 0.01,
      billedCost: 0.04,
      markupRate: DEFAULT_MARKUP_RATE,
      segments: 4,
      costPerSegment: 0.0075,
    });
  });
});
