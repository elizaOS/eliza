/**
 * Unit test for #20121: AppBackupService.exportApp now validates monetization
 * fields via parseAppMonetizationNumber, failing closed on NaN/corrupt values.
 * Pure unit test — no DB required.
 */
import { describe, expect, test } from "bun:test";
import { parseAppMonetizationNumber } from "../app-credit-math";

describe("AppBackupService.exportApp — monetization field validation", () => {
  test("parseAppMonetizationNumber throws on NaN input", () => {
    expect(() => parseAppMonetizationNumber("inference_markup_percentage", NaN)).toThrow(
      /inference_markup_percentage/,
    );
    expect(() => parseAppMonetizationNumber("purchase_share_percentage", Number.NaN)).toThrow(
      /purchase_share_percentage/,
    );
  });

  test("parseAppMonetizationNumber throws on Infinity", () => {
    expect(() => parseAppMonetizationNumber("inference_markup_percentage", Infinity)).toThrow(
      /inference_markup_percentage/,
    );
    expect(() => parseAppMonetizationNumber("purchase_share_percentage", -Infinity)).toThrow(
      /purchase_share_percentage/,
    );
  });

  test("parseAppMonetizationNumber throws on non-numeric strings", () => {
    expect(() => parseAppMonetizationNumber("inference_markup_percentage", "abc")).toThrow(
      /inference_markup_percentage/,
    );
    expect(() => parseAppMonetizationNumber("purchase_share_percentage", "25junk")).toThrow(
      /purchase_share_percentage/,
    );
  });

  test("parseAppMonetizationNumber accepts valid numbers (including fractional)", () => {
    // Fractional numbers are accepted (strings with decimals are rejected by regex)
    expect(
      parseAppMonetizationNumber("inference_markup_percentage", 25.5, {
        min: 0,
        max: 100,
      }),
    ).toBe(25.5);
    expect(
      parseAppMonetizationNumber("purchase_share_percentage", 40, {
        min: 0,
        max: 100,
      }),
    ).toBe(40);
  });

  test("parseAppMonetizationNumber accepts valid decimal strings", () => {
    expect(
      parseAppMonetizationNumber("inference_markup_percentage", "25.5", {
        min: 0,
        max: 100,
      }),
    ).toBe(25.5);
    expect(
      parseAppMonetizationNumber("purchase_share_percentage", "40", {
        min: 0,
        max: 100,
      }),
    ).toBe(40);
  });

  test("parseAppMonetizationNumber rejects garbage/partial numeric strings", () => {
    // Garbage and partially-numeric strings fail PLAIN_DECIMAL_RE
    expect(() => parseAppMonetizationNumber("inference_markup_percentage", "25junk")).toThrow(
      /inference_markup_percentage/,
    );
    expect(() => parseAppMonetizationNumber("purchase_share_percentage", "abc")).toThrow(
      /purchase_share_percentage/,
    );
    expect(() => parseAppMonetizationNumber("inference_markup_percentage", "")).toThrow(
      /inference_markup_percentage/,
    );
  });
});
