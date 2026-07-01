import { describe, expect, it } from "vitest";
import {
  clamp,
  escapeRegex,
  formatCompactCurrency,
  formatCompactNumber,
  formatPercentage,
  isNonEmptyString,
  isRecord,
  isStringArray,
  sanitizeId,
  toNumber,
} from "../../shared/src/utils/format";

/**
 * Feed shared formatting/parsing utilities. These render money/counts in the UI
 * and sanitize ids for file paths and URLs — a malformed id reaching a path is a
 * traversal risk, so sanitizeId strips everything outside [a-z0-9-_]. The
 * numeric helpers must degrade safely on NaN/Infinity rather than emit "NaN".
 */

describe("clamp", () => {
  it("bounds a value to [min, max]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe("formatCompactNumber", () => {
  it("adds K/M/B/T/Q suffixes and handles sign + non-finite", () => {
    expect(formatCompactNumber(999)).toBe("999");
    expect(formatCompactNumber(1500)).toBe("1.5K");
    expect(formatCompactNumber(2_000_000)).toBe("2.0M");
    expect(formatCompactNumber(-3_000_000_000)).toBe("-3.0B");
    expect(formatCompactNumber(Number.NaN)).toBe("0");
  });
});

describe("formatCompactCurrency", () => {
  it("prefixes the feed-points symbol, sign before symbol, safe on NaN", () => {
    // derive the configured symbol rather than hardcoding it.
    const symbol = formatCompactCurrency(0).replace("0.00", "");
    expect(formatCompactCurrency(1500)).toBe(`${symbol}1.50K`);
    expect(formatCompactCurrency(-1500)).toBe(`-${symbol}1.50K`);
    expect(formatCompactCurrency(Number.NaN)).toBe(`${symbol}0.00`);
  });
});

describe("formatPercentage", () => {
  it("rounds to a whole percent", () => {
    expect(formatPercentage(50)).toBe("50%");
    expect(formatPercentage(12.3)).toBe("12%");
  });
});

describe("sanitizeId", () => {
  it("lowercases, hyphenates spaces, strips unsafe chars, 'unknown' when empty", () => {
    expect(sanitizeId("My User ID!")).toBe("my-user-id");
    expect(sanitizeId("user_123")).toBe("user_123");
    expect(sanitizeId("../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeId(null)).toBe("unknown");
  });
});

describe("escapeRegex", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegex("a.b*c")).toBe("a\\.b\\*c");
    expect(new RegExp(`^${escapeRegex("a.b")}$`).test("axb")).toBe(false);
  });
});

describe("toNumber", () => {
  it("parses numbers/numeric strings, falls back on junk and non-finite", () => {
    expect(toNumber("3.14")).toBe(3.14);
    expect(toNumber(42)).toBe(42);
    expect(toNumber("abc")).toBe(0);
    expect(toNumber(null, -1)).toBe(-1);
    expect(toNumber(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("type guards", () => {
  it("isNonEmptyString / isRecord / isStringArray", () => {
    expect(isNonEmptyString("  x ")).toBe(true);
    expect(isNonEmptyString("   ")).toBe(false);
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isStringArray(["a", "b"])).toBe(true);
    expect(isStringArray(["a", 1])).toBe(false);
  });
});
