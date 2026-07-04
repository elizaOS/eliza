/**
 * Birdeye analytics formatting + intent extraction. These render financial
 * figures shown to the user and parse the result limit from free text, so the
 * suffix thresholds, sign handling, and clamping are pinned.
 */
import { describe, expect, it } from "vitest";
import {
  extractLimit,
  formatPercentChange,
  formatPrice,
  formatValue,
  shortenAddress,
} from "./utils.js";

describe("formatValue", () => {
  it("scales to K/M/B with a $ prefix, N/A for falsy", () => {
    expect(formatValue(undefined)).toBe("N/A");
    expect(formatValue(0)).toBe("N/A");
    expect(formatValue(500)).toBe("$500.00");
    expect(formatValue(1_500)).toBe("$1.50K");
    expect(formatValue(2_500_000)).toBe("$2.50M");
    expect(formatValue(3_000_000_000)).toBe("$3.00B");
  });
});

describe("formatPercentChange", () => {
  it("uses ↑/↓ and absolute magnitude", () => {
    expect(formatPercentChange(undefined)).toBe("N/A");
    expect(formatPercentChange(5)).toBe("↑ 5.00%");
    expect(formatPercentChange(-3.2)).toBe("↓ 3.20%");
    expect(formatPercentChange(0)).toBe("↑ 0.00%");
  });
});

describe("shortenAddress", () => {
  it("keeps short strings, abbreviates long ones", () => {
    expect(shortenAddress(undefined)).toBe("Unknown");
    expect(shortenAddress("0x1234")).toBe("0x1234");
    expect(shortenAddress("0x1234567890abcdef")).toBe("0x1234...cdef");
  });
});

describe("formatPrice", () => {
  it("uses exponential below 0.01, two decimals otherwise", () => {
    expect(formatPrice(undefined)).toBe("N/A");
    expect(formatPrice(0)).toBe("N/A");
    expect(formatPrice(0.005)).toBe("5.00e-3");
    expect(formatPrice(12.5)).toBe("12.50");
  });
});

describe("extractLimit", () => {
  it("reads explicit limits and clamps to 1..100", () => {
    expect(extractLimit("show 25 tokens")).toBe(25);
    expect(extractLimit("show 500")).toBe(100);
    expect(extractLimit("show 0")).toBe(1);
  });

  it("falls back to semantic and contextual hints", () => {
    expect(extractLimit("give me everything")).toBe(100);
    expect(extractLimit("quick summary")).toBe(5);
    expect(extractLimit("detailed report")).toBe(50);
    expect(extractLimit("recent trades")).toBe(10);
    expect(extractLimit("analyze the trend")).toBe(24);
    expect(extractLimit("historical data")).toBe(50);
    expect(extractLimit("hello")).toBe(10);
  });
});
