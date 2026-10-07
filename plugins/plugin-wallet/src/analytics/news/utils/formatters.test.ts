/**
 * DeFi news formatters render financial figures and validate token addresses.
 * Magnitude suffixes, percent sign/emoji, and address-shape validation must be
 * exact — isValidTokenAddress in particular gates EVM/Solana address inputs.
 */
import { describe, expect, it } from "vitest";
import {
  extractTokenSymbol,
  formatCurrency,
  formatNumber,
  formatPercentage,
  getSentimentEmoji,
  isValidTokenAddress,
  stripHtml,
} from "./formatters.js";

describe("formatCurrency", () => {

  it.each([
    [999.994, "$999.99"],
    [999.999, "$1.00K"],
    [999_999, "$1.00M"],
    [999_999_999, "$1.00B"],
    [-999.994, "$-999.99"],
    [-999.999, "$-1.00K"],
    [-999_999, "$-1.00M"],
    [-999_999_999, "$-1.00B"],
    [2.675, "$2.67"],
    [-2.675, "$-2.67"],
  ])("preserves toFixed rounding and promotes signed tiers for %s", (value, expected) => {
    expect(formatCurrency(value)).toBe(expected);
  });

  it("keeps zero and honors precision at the base and trillion boundaries", () => {
    expect(formatCurrency(0)).toBe("$0.00");
    expect(formatCurrency(999.6, 0)).toBe("$1K");
    expect(formatCurrency(-999.6, 0)).toBe("$-1K");
    expect(formatCurrency(999.9994, 3)).toBe("$999.999");
    expect(formatCurrency(999.9996, 3)).toBe("$1.000K");
    expect(formatCurrency(999_999_999_999)).toBe("$1.00T");
    expect(formatCurrency(-999_999_999_999)).toBe("$-1.00T");
  });
  it("scales with T/B/M/K suffixes", () => {
    expect(formatCurrency(1.5e12)).toBe("$1.50T");
    expect(formatCurrency(2.5e9)).toBe("$2.50B");
    expect(formatCurrency(3.5e6)).toBe("$3.50M");
    expect(formatCurrency(4.5e3)).toBe("$4.50K");
    expect(formatCurrency(12.3)).toBe("$12.30");
  });
});

describe("formatPercentage", () => {
  it("adds sign + trend emoji", () => {
    expect(formatPercentage(5)).toBe("📈 +5.00%");
    expect(formatPercentage(-3.2)).toBe("📉 -3.20%");
  });
});

describe("text helpers", () => {
  it("formats sentiment, numbers, symbols, and HTML text", () => {
    expect(getSentimentEmoji("positive")).toBe("😊");
    expect(getSentimentEmoji("negative")).toBe("😟");
    expect(getSentimentEmoji(undefined)).toBe("😐");
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(extractTokenSymbol("buy some WBTC now")).toBe("WBTC");
    expect(extractTokenSymbol("nothing here")).toBeNull();
    expect(stripHtml("<p>hi <b>there</b></p>")).toBe("hi there");
  });
});

describe("isValidTokenAddress", () => {
  it("accepts EVM + Solana shapes, rejects others", () => {
    expect(isValidTokenAddress(`0x${"a".repeat(40)}`)).toBe(true);
    expect(
      isValidTokenAddress("So11111111111111111111111111111111111111112"),
    ).toBe(true);
    expect(isValidTokenAddress("0x123")).toBe(false); // too short
    expect(isValidTokenAddress(`0x${"g".repeat(40)}`)).toBe(false); // non-hex
    expect(isValidTokenAddress("not an address")).toBe(false);
  });
});
