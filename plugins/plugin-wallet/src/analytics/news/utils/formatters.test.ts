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
  truncateText,
} from "./formatters.js";

describe("formatCurrency", () => {
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
  it("truncateText, getSentimentEmoji, formatNumber, extractTokenSymbol, stripHtml", () => {
    expect(truncateText("short", 200)).toBe("short");
    expect(truncateText("abcdef", 3)).toBe("abc...");
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
