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
});
