import { describe, expect, it } from "vitest";
import {
  errorMessage,
  formatRateLimitMessage,
  inspectRateLimit,
} from "./rate-limit";

describe("inspectRateLimit", () => {
  it("detects a rate-limited GitHub response from lowercase headers", () => {
    const details = inspectRateLimit({
      status: 403,
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1724500000",
        },
      },
    });
    expect(details.isRateLimited).toBe(true);
    expect(details.remaining).toBe(0);
    expect(details.resetAtMs).toBe(1724500000000);
  });

  it("detects a rate-limited response with capitalized header names", () => {
    // Node's fetch lowercases header keys, but errors can arrive from
    // caching proxies or SDKs that preserve original casing; a missed
    // match would surface the raw 403 instead of the rate-limit verdict.
    const details = inspectRateLimit({
      status: 403,
      response: {
        headers: {
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1724500000",
        },
      },
    });
    expect(details.isRateLimited).toBe(true);
    expect(details.remaining).toBe(0);
    expect(details.resetAtMs).toBe(1724500000000);
  });

  it("detects a rate-limited response with mixed-case header names", () => {
    const details = inspectRateLimit({
      status: 403,
      response: {
        headers: { "x-RateLimit-remaining": "0" },
      },
    });
    expect(details.isRateLimited).toBe(true);
  });

  it("accepts numeric header values", () => {
    const details = inspectRateLimit({
      status: 403,
      response: {
        headers: {
          "x-ratelimit-remaining": 0,
          "x-ratelimit-reset": 1724500000,
        },
      },
    });
    expect(details.isRateLimited).toBe(true);
    expect(details.resetAtMs).toBe(1724500000000);
  });

  it("is not rate limited when remaining is non-zero", () => {
    const details = inspectRateLimit({
      status: 403,
      response: {
        headers: { "x-ratelimit-remaining": "5" },
      },
    });
    expect(details.isRateLimited).toBe(false);
    expect(details.remaining).toBe(5);
  });

  it("is not rate limited for non-403 statuses even with zero remaining", () => {
    const details = inspectRateLimit({
      status: 429,
      response: {
        headers: { "x-ratelimit-remaining": "0" },
      },
    });
    expect(details.isRateLimited).toBe(false);
  });

  it("is not rate limited when headers are absent", () => {
    const details = inspectRateLimit({ status: 403 });
    expect(details.isRateLimited).toBe(false);
    expect(details.remaining).toBe(null);
    expect(details.resetAtMs).toBe(null);
  });

  it("leaves resetAtMs null when the reset header is missing or invalid", () => {
    expect(
      inspectRateLimit({
        status: 403,
        response: { headers: { "x-ratelimit-remaining": "0" } },
      }).resetAtMs,
    ).toBe(null);
    expect(
      inspectRateLimit({
        status: 403,
        response: {
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "abc" },
        },
      }).resetAtMs,
    ).toBe(null);
  });

  it("handles non-object errors without throwing", () => {
    expect(inspectRateLimit("boom").isRateLimited).toBe(false);
    expect(inspectRateLimit(null).isRateLimited).toBe(false);
    expect(inspectRateLimit(undefined).isRateLimited).toBe(false);
  });

  it("handles Error instances without throwing", () => {
    const details = inspectRateLimit(new Error("network"));
    expect(details.isRateLimited).toBe(false);
    expect(details.remaining).toBe(null);
  });
});

describe("formatRateLimitMessage", () => {
  it("reports a generic failure when not rate limited", () => {
    expect(
      formatRateLimitMessage({
        isRateLimited: false,
        remaining: null,
        resetAtMs: null,
      }),
    ).toBe("GitHub request failed");
  });

  it("reports exhaustion without a reset time", () => {
    expect(
      formatRateLimitMessage({
        isRateLimited: true,
        remaining: 0,
        resetAtMs: null,
      }),
    ).toBe("GitHub rate limit exhausted");
  });

  it("renders the reset instant when known", () => {
    const message = formatRateLimitMessage({
      isRateLimited: true,
      remaining: 0,
      resetAtMs: 1724500000000,
    });
    expect(message).toMatch(/^GitHub rate limit exhausted; resets at /);
    expect(message).toContain(new Date(1724500000000).toISOString());
  });
});

describe("errorMessage", () => {
  it("returns Error messages", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns strings verbatim", () => {
    expect(errorMessage("plain failure")).toBe("plain failure");
  });

  it("extracts message from object-like errors", () => {
    expect(errorMessage({ message: "structured" })).toBe("structured");
    expect(errorMessage({ status: 500 })).toBe("unknown error");
  });

  it("stringifies non-object values", () => {
    expect(errorMessage(42)).toBe("42");
  });
});
