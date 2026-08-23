/**
 * Unit tests for vault internal validation and surrogate-safe string utilities.
 */

import { describe, expect, it } from "vitest";
import {
  assertKey,
  optsCaller,
  toWellFormedUnicode,
  truncateWellFormed,
} from "../src/internal-utils.js";

describe("assertKey", () => {
  it("accepts valid keys up to 256 characters", () => {
    expect(() => assertKey("api_key")).not.toThrow();
    expect(() => assertKey("a")).not.toThrow();
    expect(() => assertKey("a".repeat(256))).not.toThrow();
  });

  it("throws TypeError on non-string inputs", () => {
    // @ts-expect-error test invalid input type
    expect(() => assertKey(null)).toThrow(TypeError);
    // @ts-expect-error test invalid input type
    expect(() => assertKey(undefined)).toThrow(TypeError);
    // @ts-expect-error test invalid input type
    expect(() => assertKey(123)).toThrow(TypeError);
    // @ts-expect-error test invalid input type
    expect(() => assertKey({})).toThrow(TypeError);
  });

  it("throws TypeError on empty or whitespace-only keys", () => {
    expect(() => assertKey("")).toThrow(TypeError);
    expect(() => assertKey("   ")).toThrow(TypeError);
    expect(() => assertKey("\t\n")).toThrow(TypeError);
  });

  it("throws TypeError on keys exceeding 256 characters", () => {
    expect(() => assertKey("a".repeat(257))).toThrow(
      "vault: key must be 256 characters or fewer",
    );
  });
});

describe("optsCaller", () => {
  it("extracts caller when present in options", () => {
    expect(optsCaller({ caller: "admin-service" })).toEqual({
      caller: "admin-service",
    });
  });

  it("returns empty object when caller is absent or empty", () => {
    expect(optsCaller({})).toEqual({});
    expect(optsCaller({ caller: undefined })).toEqual({});
    expect(optsCaller({ caller: "" })).toEqual({});
  });
});

describe("toWellFormedUnicode", () => {
  it("preserves well-formed ASCII and Unicode text", () => {
    expect(toWellFormedUnicode("hello world")).toBe("hello world");
    expect(toWellFormedUnicode("caf\u00e9")).toBe("caf\u00e9");
    expect(toWellFormedUnicode("\uD83D\uDE00")).toBe("\uD83D\uDE00");
  });

  it("sanitizes lone high or low surrogates", () => {
    const loneHigh = "bad \uD800 char";
    const loneLow = "bad \uDC00 char";

    const wellFormedHigh = toWellFormedUnicode(loneHigh);
    const wellFormedLow = toWellFormedUnicode(loneLow);

    expect(wellFormedHigh).not.toContain("\uD800");
    expect(wellFormedLow).not.toContain("\uDC00");
  });
});

describe("truncateWellFormed", () => {
  it("returns empty string for non-positive or non-finite maxLength", () => {
    expect(truncateWellFormed("hello", 0)).toBe("");
    expect(truncateWellFormed("hello", -5)).toBe("");
    expect(truncateWellFormed("hello", Number.NaN)).toBe("");
  });

  it("returns original text when text length is within maxLength", () => {
    expect(truncateWellFormed("short", 10)).toBe("short");
    expect(truncateWellFormed("exact", 5)).toBe("exact");
  });

  it("truncates normal ASCII string at boundary", () => {
    expect(truncateWellFormed("hello world", 5)).toBe("hello");
  });

  it("avoids splitting surrogate pairs across the truncation boundary", () => {
    // Emoji "\uD83D\uDE00" (grinning face) is 2 code units: \uD83D (high) + \uDE00 (low)
    const text = "abc\uD83D\uDE00def"; // length 8: 'a'(0), 'b'(1), 'c'(2), '\uD83D'(3), '\uDE00'(4), 'd'(5)...

    // Truncating at index 4 would split the pair after the high surrogate \uD83D.
    // truncateWellFormed should back off by 1 to index 3 ("abc") to prevent a lone high surrogate.
    expect(truncateWellFormed(text, 4)).toBe("abc");

    // Truncating at index 5 includes both surrogates ("abc\uD83D\uDE00")
    expect(truncateWellFormed(text, 5)).toBe("abc\uD83D\uDE00");
  });
});
