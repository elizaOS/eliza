/**
 * Coverage for `retryDelayMs`'s RFC 7231 Retry-After parsing (delay-seconds
 * and HTTP-date forms) and its exponential-backoff fallback.
 */
import { describe, expect, it } from "vitest";
import { retryDelayMs } from "./proxy-client";

describe("retryDelayMs", () => {
  it("parses delay-seconds form", () => {
    expect(retryDelayMs("120", 0)).toBe(120_000);
  });

  it("parses an HTTP-date in the future", () => {
    const target = new Date(Date.now() + 60_000);
    const delay = retryDelayMs(target.toUTCString(), 0);
    expect(delay).toBeGreaterThan(55_000);
    expect(delay).toBeLessThanOrEqual(60_000);
  });

  it.each(["Sunday, 06-Nov-37 08:49:37 GMT", "Sun Nov  6 08:49:37 2037"])(
    "accepts the obsolete HTTP-date form %s",
    (header) => {
      expect(retryDelayMs(header, 0)).toBeGreaterThan(0);
    },
  );

  it("clamps an HTTP-date in the past to 0, not negative", () => {
    const past = new Date(Date.now() - 60_000);
    expect(retryDelayMs(past.toUTCString(), 0)).toBe(0);
  });

  it("falls back to exponential backoff when the header is missing", () => {
    expect(retryDelayMs(null, 0)).toBe(1000);
    expect(retryDelayMs(null, 3)).toBe(8000);
  });

  it("falls back to exponential backoff instead of NaN on an unparseable header", () => {
    const delay = retryDelayMs("not-a-valid-header", 1);
    expect(delay).toBe(2000);
    expect(Number.isNaN(delay)).toBe(false);
  });

  it.each(["1.5", "1e3", "+2", "tomorrow"])(
    "rejects non-RFC numeric syntax %s",
    (header) => {
      expect(retryDelayMs(header, 1)).toBe(2000);
    },
  );

  it("bounds valid delays to the JavaScript timer maximum", () => {
    expect(retryDelayMs("999999999999999999999999", 0)).toBe(2_147_483_647);
    expect(retryDelayMs("Fri, 31 Dec 9999 23:59:59 GMT", 0)).toBe(
      2_147_483_647,
    );
  });
});
