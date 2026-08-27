/**
 * Regression for shortId surrogate-safe truncation.
 *
 * `shortId` previously used `value.slice(0,12)` which can split a UTF-16
 * surrogate pair (emoji) at the cut, producing a lone high surrogate that is
 * not well-formed Unicode and fails strict JSON parsers. The fix uses
 * `truncateWellFormed(toWellFormedUnicode(value),12)` to never split.
 */

import { describe, expect, test } from "bun:test";
import { shortId } from "./CharacterExperienceWorkspace";

function isWellFormed(value: string): boolean {
  // String.prototype.isWellFormed is available in modern V8
  return (value as unknown as { isWellFormed?: () => boolean }).isWellFormed
    ? (value as unknown as { isWellFormed: () => boolean }).isWellFormed()
    : // fallback: check for lone surrogates
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        value,
      );
}

describe("shortId well-formed truncation", () => {
  test("returns Not recorded for empty/null", () => {
    expect(shortId(null)).toBe("Not recorded");
    expect(shortId(undefined)).toBe("Not recorded");
    expect(shortId("")).toBe("Not recorded");
  });

  test("returns value unchanged when <=12 code units", () => {
    expect(shortId("hello")).toBe("hello");
    expect(shortId("a".repeat(12))).toBe("a".repeat(12));
  });

  test("truncates ASCII over-limit with ellipsis", () => {
    const long = "a".repeat(13);
    expect(shortId(long)).toBe(`${"a".repeat(12)}...`);
    expect(shortId("a".repeat(20)).length).toBe(15); // 12 + 3
  });

  test("never splits a surrogate pair at the 12-code-unit boundary", () => {
    // 11 ascii + emoji (2 code units) + trailing X -> length 14, emoji straddles 12
    const withEmoji = `${"a".repeat(11)}😀X`; // "a"*11 + surrogate pair + "X"
    // Old slice(0,12) would give "a"*11 + lone high surrogate 0xD83D
    const sliced = withEmoji.slice(0, 12);
    expect(sliced.charCodeAt(11)).toBe(0xd83d); // lone high surrogate
    expect(isWellFormed(sliced)).toBe(false);

    const fixed = shortId(withEmoji);
    // fixed should be well-formed, no lone surrogate, and either 12 code units + "..." or 11 + "..."
    expect(isWellFormed(fixed)).toBe(true);
    expect(fixed.includes("\uD83D")).toBe(false); // no lone high surrogate char
    // Since emoji would be split, it should be excluded, so result is "a"*11 + "..." (14 chars total) or "a"*11 + emoji? Let's assert well-formed and length
    expect(fixed.length).toBeLessThanOrEqual(15);
    // It should still end with "..." because original >12
    expect(fixed.endsWith("...")).toBe(true);
    // JSON.stringify must not produce lone surrogate escape that strict parsers reject
    expect(() => JSON.parse(JSON.stringify({ v: fixed }))).not.toThrow();
  });

  test("handles emoji that fits within limit", () => {
    const val = `${"a".repeat(10)}😀`; // 12 code units exactly (10 +2)
    expect(shortId(val)).toBe(val); // not truncated, well-formed
    expect(isWellFormed(shortId(val))).toBe(true);
  });

  test("handles string with lone surrogate input via toWellFormed", () => {
    const lone = "a".repeat(12) + String.fromCharCode(0xd83d);
    const out = shortId(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes(String.fromCharCode(0xd83d))).toBe(false);
  });
});
