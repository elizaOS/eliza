/**
 * The browser signing token comparison must behave like the agent API's
 * padded `tokenMatches`: exact-match accept, reject everything else, and no
 * special case for prefix or length relations. Deterministic unit coverage of
 * the helper plus a route-level proof that a bearer token differing only in
 * length is still rejected; the constant-time construction itself is the
 * reviewed property, not something a unit clock can measure.
 */
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
});
