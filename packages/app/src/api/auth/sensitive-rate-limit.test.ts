/**
 * Tests the sensitive-auth rate limiters: per-IP attempt budgets
 * (`SENSITIVE_RATE_LIMIT_MAX` over the window), isolation between named route
 * buckets, rejection of empty limiter names, window-expiry reset, the shared
 * null-IP "unknown" bucket, and the `_resetSensitiveLimiters` test hook (which
 * also clears the shared `bootstrapExchangeLimiter`). Time is passed explicitly,
 * so there is no fake clock.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetSensitiveLimiters,
  bootstrapExchangeLimiter,
  getSensitiveLimiter,
  SENSITIVE_RATE_LIMIT_MAX,
  SENSITIVE_RATE_LIMIT_WINDOW_MS,
} from "./sensitive-rate-limit";

describe("sensitive auth rate limiters", () => {
  afterEach(() => {
    _resetSensitiveLimiters();
  });

  it("allows the configured number of attempts per ip and denies the next one", () => {
    const limiter = getSensitiveLimiter("auth.test.limit");
    const now = 1_000;

    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i += 1) {
      expect(limiter.consume("203.0.113.8", now + i)).toBe(true);
    }

    expect(limiter.consume("203.0.113.8", now + SENSITIVE_RATE_LIMIT_MAX)).toBe(
      false,
    );
    expect(limiter.consume("203.0.113.9", now + SENSITIVE_RATE_LIMIT_MAX)).toBe(
      true,
    );
  });

  it("keeps named route buckets isolated for the same client ip", () => {
    const first = getSensitiveLimiter("auth.test.first");
    const second = getSensitiveLimiter("auth.test.second");
    const now = 2_000;

    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i += 1) {
      expect(first.consume("198.51.100.10", now + i)).toBe(true);
    }

    expect(first.consume("198.51.100.10", now + 10)).toBe(false);
    expect(second.consume("198.51.100.10", now + 10)).toBe(true);
  });

  it("rejects empty limiter names so unrelated callers do not share a bucket", () => {
    expect(() => getSensitiveLimiter("  ")).toThrow(
      "Sensitive limiter name is required",
    );
  });

  it("resets expired windows and treats null ip as a shared unknown bucket", () => {
    const limiter = getSensitiveLimiter("auth.test.window");
    const now = 3_000;

    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i += 1) {
      expect(limiter.consume(null, now + i)).toBe(true);
    }

    expect(limiter.consume(null, now + 20)).toBe(false);
    expect(limiter.consume(null, now + SENSITIVE_RATE_LIMIT_WINDOW_MS)).toBe(
      true,
    );
  });

  it("test reset hook clears all registered limiters including bootstrapExchangeLimiter", () => {
    const routeLimiter = getSensitiveLimiter("auth.test.reset");
    const now = 4_000;

    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i += 1) {
      expect(routeLimiter.consume("192.0.2.44", now + i)).toBe(true);
      expect(bootstrapExchangeLimiter.consume("192.0.2.55", now + i)).toBe(
        true,
      );
    }

    expect(routeLimiter.consume("192.0.2.44", now + 20)).toBe(false);
    expect(bootstrapExchangeLimiter.consume("192.0.2.55", now + 20)).toBe(
      false,
    );

    _resetSensitiveLimiters();

    expect(routeLimiter.consume("192.0.2.44", now + 21)).toBe(true);
    expect(bootstrapExchangeLimiter.consume("192.0.2.55", now + 21)).toBe(true);
  });
});
