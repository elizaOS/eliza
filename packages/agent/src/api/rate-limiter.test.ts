import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, resetRateLimits } from "./rate-limiter.ts";

const HOUR = 60 * 60 * 1_000;
const MINUTE = 60 * 1_000;

describe("checkRateLimit", () => {
  beforeEach(() => {
    // Fake timers start at the real current time, so the module-level sweep
    // clock (initialized at import time) stays behind the fake "now" and a
    // 6-minute advance reliably crosses the 5-minute sweep throttle.
    vi.useFakeTimers();
    resetRateLimits();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to maxRequests then rejects with a retry hint", () => {
    const config = { maxRequests: 2, windowMs: MINUTE };
    expect(checkRateLimit("k", config).allowed).toBe(true);
    expect(checkRateLimit("k", config).allowed).toBe(true);
    const third = checkRateLimit("k", config);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
    expect(third.retryAfterMs).toBeLessThanOrEqual(MINUTE);
  });

  it("allows again once the window slides past the oldest request", () => {
    const config = { maxRequests: 1, windowMs: MINUTE };
    expect(checkRateLimit("k", config).allowed).toBe(true);
    expect(checkRateLimit("k", config).allowed).toBe(false);
    vi.advanceTimersByTime(MINUTE + 1);
    expect(checkRateLimit("k", config).allowed).toBe(true);
  });

  it("does not let a short-window key's cleanup sweep wipe a longer-window bucket", () => {
    // Key A: 2 requests per HOUR — exhaust it.
    const hourly = { maxRequests: 2, windowMs: HOUR };
    expect(checkRateLimit("hourly-op", hourly).allowed).toBe(true);
    expect(checkRateLimit("hourly-op", hourly).allowed).toBe(true);
    expect(checkRateLimit("hourly-op", hourly).allowed).toBe(false);

    // 6 minutes later (past the 5-minute sweep throttle) a DIFFERENT key with
    // a 1-second window triggers the periodic cleanup. The sweep used to prune
    // EVERY bucket with the caller's 1s cutoff, erasing hourly-op's 6-minute-old
    // timestamps and resetting its limit.
    vi.advanceTimersByTime(6 * MINUTE);
    checkRateLimit("bursty-op", { maxRequests: 100, windowMs: 1_000 });

    // Still only 6 minutes into hourly-op's 1-hour window: must stay blocked.
    expect(checkRateLimit("hourly-op", hourly).allowed).toBe(false);
  });
});
