import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter, type RateLimiter } from "./rate-limiter.js";

describe("createRateLimiter", () => {
  let limiter: RateLimiter | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    limiter?.dispose();
    limiter = null;
    vi.useRealTimers();
  });

  it("validates windowMs and sweepIntervalMs options", () => {
    expect(() => createRateLimiter({ windowMs: 0 })).toThrow(RangeError);
    expect(() => createRateLimiter({ windowMs: -1000 })).toThrow(RangeError);
    expect(() => createRateLimiter({ windowMs: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() =>
      createRateLimiter({ windowMs: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError);
    expect(() =>
      createRateLimiter({ windowMs: "1000" as unknown as number }),
    ).toThrow(RangeError);

    expect(() =>
      createRateLimiter({ windowMs: 1000, sweepIntervalMs: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createRateLimiter({ windowMs: 1000, sweepIntervalMs: -500 }),
    ).toThrow(RangeError);
    expect(() =>
      createRateLimiter({ windowMs: 1000, sweepIntervalMs: Number.NaN }),
    ).toThrow(RangeError);
  });

  it("allows initial action and blocks subsequent actions within windowMs", () => {
    limiter = createRateLimiter({ windowMs: 5000 });

    const first = limiter.check("user-1");
    expect(first.allowed).toBe(true);
    expect(first.retryAfterSeconds).toBe(0);

    const second = limiter.check("user-1");
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBe(5);

    // Independent key is allowed
    const other = limiter.check("user-2");
    expect(other.allowed).toBe(true);
    expect(other.retryAfterSeconds).toBe(0);
  });

  it("allows actions after windowMs has elapsed", () => {
    limiter = createRateLimiter({ windowMs: 5000 });

    expect(limiter.check("key-1").allowed).toBe(true);
    expect(limiter.check("key-1").allowed).toBe(false);

    vi.advanceTimersByTime(3000);
    expect(limiter.check("key-1").allowed).toBe(false);

    vi.advanceTimersByTime(2001);
    const retry = limiter.check("key-1");
    expect(retry.allowed).toBe(true);
    expect(retry.retryAfterSeconds).toBe(0);
  });

  it("peek checks rate limit state without recording an action", () => {
    limiter = createRateLimiter({ windowMs: 5000 });

    expect(limiter.peek("key-1").allowed).toBe(true);
    expect(limiter.peek("key-1").allowed).toBe(true);

    // Now record an action
    expect(limiter.check("key-1").allowed).toBe(true);

    const peekBlocked = limiter.peek("key-1");
    expect(peekBlocked.allowed).toBe(false);
    expect(peekBlocked.retryAfterSeconds).toBe(5);
  });

  it("ensures retryAfterSeconds is at least 1 when blocked", () => {
    limiter = createRateLimiter({ windowMs: 1000 });

    limiter.check("key-1");
    vi.advanceTimersByTime(999);

    const check = limiter.peek("key-1");
    expect(check.allowed).toBe(false);
    expect(check.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("clears tracked keys", () => {
    limiter = createRateLimiter({ windowMs: 5000 });

    limiter.check("key-1");
    limiter.check("key-2");

    expect(limiter.peek("key-1").allowed).toBe(false);
    expect(limiter.peek("key-2").allowed).toBe(false);

    limiter.clear();

    expect(limiter.peek("key-1").allowed).toBe(true);
    expect(limiter.peek("key-2").allowed).toBe(true);
  });

  it("disposes resources and is safe for multiple dispose calls", () => {
    limiter = createRateLimiter({ windowMs: 5000 });

    limiter.check("key-1");
    limiter.dispose();

    expect(limiter.peek("key-1").allowed).toBe(true);
    expect(() => limiter?.dispose()).not.toThrow();
  });

  it("sweeps stale entries beyond 2x windowMs", () => {
    limiter = createRateLimiter({ windowMs: 1000, sweepIntervalMs: 1000 });

    limiter.check("stale-key");
    vi.advanceTimersByTime(2500);

    // After 2.5s (> 2 * windowMs), sweep timer has removed stale-key
    expect(limiter.peek("stale-key").allowed).toBe(true);
  });
});
