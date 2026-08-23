/** Verifies dependency-free Unicode repair and UTF-16-safe diagnostic truncation. */

import { describe, expect, test } from "bun:test";
import { toWellFormedUnicode, truncateWellFormed } from "../src/text";

describe("cloud service diagnostic text", () => {
  test("preserves valid surrogate pairs", () => {
    expect(toWellFormedUnicode("before 🦊 after")).toBe("before 🦊 after");
  });

  test("replaces lone high and low surrogates", () => {
    expect(toWellFormedUnicode("before\ud83dafter")).toBe("before�after");
    expect(toWellFormedUnicode("before\udc00after")).toBe("before�after");
  });

  test("backs off instead of splitting a surrogate pair", () => {
    expect(truncateWellFormed("ab🦊cd", 3)).toBe("ab");
  });

  test("preserves ordinary truncation and fitting text", () => {
    expect(truncateWellFormed("abcdef", 3)).toBe("abc");
    expect(truncateWellFormed("abc", 3)).toBe("abc");
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns empty text for invalid budget %s",
    (max) => {
      expect(truncateWellFormed("diagnostic", max)).toBe("");
    },
  );
});
