/**
 * The browser signing token comparison must behave like the agent API's
 * padded `tokenMatches`: exact-match accept, reject everything else, and no
 * special case for prefix or length relations. Deterministic unit coverage of
 * the helper plus a route-level proof that a bearer token differing only in
 * length is still rejected; the constant-time construction itself is the
 * reviewed property, not something a unit clock can measure.
 */
import { timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import { browserSignTokenMatches } from "../browser-sign-token";

describe("browserSignTokenMatches", () => {
  it("accepts only the exact token", () => {
    expect(
      browserSignTokenMatches("0123456789abcdef", "0123456789abcdef"),
    ).toBe(true);
    expect(
      browserSignTokenMatches(
        "token-with-\u00e9\u00e0-unicode",
        "token-with-\u00e9\u00e0-unicode",
      ),
    ).toBe(true);
  });

  it("rejects a prefix, an extension, and an unrelated token of equal length", () => {
    expect(browserSignTokenMatches("0123456789abcdef", "0123456789abcde")).toBe(
      false,
    );
    expect(
      browserSignTokenMatches("0123456789abcdef", "0123456789abcdef0"),
    ).toBe(false);
    expect(
      browserSignTokenMatches("0123456789abcdef", "0123456789abcdeg"),
    ).toBe(false);
  });

  it("rejects an empty provided token against a configured one", () => {
    expect(browserSignTokenMatches("0123456789abcdef", "")).toBe(false);
  });

  it("performs the safe comparison for every input, including mismatched lengths", () => {
    // The length decision must not gate the comparison: a fast path that
    // skips the padded compare on length mismatch would reveal the expected
    // token's length through timing. A counting compare observes the call
    // directly instead of trying to measure time.
    const calls: Array<[number, number]> = [];
    const countingCompare = (a: Buffer, b: Buffer): boolean => {
      calls.push([a.length, b.length]);
      return false;
    };
    expect(
      browserSignTokenMatches("0123456789abcdef", "short", countingCompare),
    ).toBe(false);
    expect(
      browserSignTokenMatches(
        "0123456789abcdef",
        "0123456789abcdef0",
        countingCompare,
      ),
    ).toBe(false);
    expect(browserSignTokenMatches("", "x", countingCompare)).toBe(false);
    expect(calls).toEqual([
      [16, 16],
      [17, 17],
      [1, 1],
    ]);
  });

  it("pads both sides to a common length so the compare never throws", () => {
    const seen: Array<[Buffer, Buffer]> = [];
    browserSignTokenMatches("abc", "much longer token", (a, b) => {
      seen.push([a, b]);
      return timingSafeEqual(a, b);
    });
    expect(seen).toHaveLength(1);
    const [a, b] = seen[0];
    expect(a.length).toBe(b.length);
    expect(a.subarray(0, 3).toString("utf8")).toBe("abc");
  });
});
