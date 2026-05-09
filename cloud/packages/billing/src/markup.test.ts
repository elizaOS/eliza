import { describe, expect, test } from "vitest";
import {
  applyMarkup,
  applyMarkupCents,
  calculateTwilioSmsBilling,
  DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD,
  estimateTwilioSmsSegments,
  resolveTwilioSmsCostPerSegment,
  roundUsd,
} from "./markup";

describe("markup helpers", () => {
  test("rounds marked-up USD costs at the billing boundary", () => {
    expect(applyMarkup(0.014)).toEqual({
      rawCost: 0.01,
      markup: 0,
      billedCost: 0.01,
      markupRate: 0.2,
    });
    expect(applyMarkup(0.015)).toEqual({
      rawCost: 0.02,
      markup: 0,
      billedCost: 0.02,
      markupRate: 0.2,
    });
    expect(applyMarkup(0.05)).toEqual({
      rawCost: 0.05,
      markup: 0.01,
      billedCost: 0.06,
      markupRate: 0.2,
    });
  });

  test("supports explicit sub-cent USD precision", () => {
    expect(roundUsd(0.0060004, 6)).toBe(0.006);
    expect(applyMarkup(0.005, undefined, 6)).toEqual({
      rawCost: 0.005,
      markup: 0.001,
      billedCost: 0.006,
      markupRate: 0.2,
    });
  });

  test("handles zero and rejects negative or non-finite costs", () => {
    expect(applyMarkup(0).billedCost).toBe(0);
    expect(applyMarkupCents(0)).toBe(0);
    expect(() => applyMarkup(-0.01)).toThrow(RangeError);
    expect(() => applyMarkup(Number.NaN)).toThrow(RangeError);
    expect(() => applyMarkupCents(-1)).toThrow(RangeError);
    expect(() => applyMarkupCents(1.1)).toThrow(RangeError);
  });
});

describe("Twilio SMS billing", () => {
  test.each([
    ["", 1],
    ["a", 1],
    ["a".repeat(160), 1],
    ["a".repeat(161), 2],
    ["a".repeat(320), 2],
    ["a".repeat(321), 3],
  ])("estimates segment count at a boundary", (body, segments) => {
    expect(estimateTwilioSmsSegments(body)).toBe(segments);
  });

  test("calculates provider cost and markup from shared segment rules", () => {
    expect(calculateTwilioSmsBilling("a".repeat(161), 0.0075)).toEqual({
      rawCost: 0.02,
      markup: 0,
      billedCost: 0.02,
      markupRate: 0.2,
      segments: 2,
      costPerSegment: 0.0075,
    });
  });

  test("resolves configured SMS segment cost with a shared fallback", () => {
    expect(resolveTwilioSmsCostPerSegment(undefined)).toBe(DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD);
    expect(resolveTwilioSmsCostPerSegment("0.01")).toBe(0.01);
    expect(resolveTwilioSmsCostPerSegment(0)).toBe(0);
    expect(resolveTwilioSmsCostPerSegment("-1")).toBe(DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD);
    expect(resolveTwilioSmsCostPerSegment("not-a-number")).toBe(
      DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD,
    );
  });

  test("rejects negative or non-finite SMS costs", () => {
    expect(calculateTwilioSmsBilling("hello", 0).billedCost).toBe(0);
    expect(() => calculateTwilioSmsBilling("hello", -0.01)).toThrow(RangeError);
    expect(() => calculateTwilioSmsBilling("hello", Number.NaN)).toThrow(RangeError);
  });
});
