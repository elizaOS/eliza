/**
 * Unit tests for the Tier-3 in-isolate decision lease in `enforceOrgRateLimit`
 * (#9899), gated behind INFERENCE_HOT_PATH_CACHES. The Redis check and the
 * org-tier read are mocked at the module boundary so the tests can count
 * authoritative round-trips and observe the carried-count flush; the lease
 * logic under test is real. The convergence test simulates the real sliding
 * window (including carried members) to prove a hot isolate cannot exceed the
 * org limit by more than one in-flight lease budget.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as orgRateLimitsActual from "../services/org-rate-limits";
import * as rateLimitRedisActual from "./rate-limit-redis";

let redisChecks = 0;
let redisResult: rateLimitRedisActual.RateLimitResult;
let tierReads = 0;
let tierConfig = { windowMs: 60_000, maxRequests: 120 };
/** carriedCount received per authoritative check, in order. */
let carriedCounts: number[] = [];
/**
 * When set, the mock behaves like the REAL sliding window instead of returning
 * `redisResult`: carried members are appended before the count, the current
 * request after — mirroring checkRateLimitRedis's pipeline math.
 */
let simulateWindow = false;
let windowCount = 0;

mock.module("./rate-limit-redis", () => ({
  ...rateLimitRedisActual,
  checkRateLimitRedis: async (
    _key: string,
    _windowMs: number,
    maxRequests: number,
    options?: { carriedCount?: number },
  ) => {
    redisChecks++;
    const carried = options?.carriedCount ?? 0;
    carriedCounts.push(carried);
    if (!simulateWindow) return redisResult;
    windowCount += carried;
    const allowed = windowCount < maxRequests;
    const remaining = Math.max(0, maxRequests - windowCount - 1);
    windowCount += 1;
    return {
      allowed,
      remaining,
      resetAt: Date.now() + 60_000,
      retryAfter: allowed ? undefined : 60,
    };
  },
}));

mock.module("../services/org-rate-limits", () => ({
  ...orgRateLimitsActual,
  getOrgRpmForEndpoint: async () => {
    tierReads++;
    return tierConfig;
  },
}));

const { enforceOrgRateLimit, __clearOrgRateLimitLeases } = await import("./rate-limit");

const originalRedisRateLimiting = process.env.REDIS_RATE_LIMITING;
const originalHotPathCaches = process.env.INFERENCE_HOT_PATH_CACHES;

afterAll(() => {
  mock.module("./rate-limit-redis", () => rateLimitRedisActual);
  mock.module("../services/org-rate-limits", () => orgRateLimitsActual);
  for (const [name, value] of [
    ["REDIS_RATE_LIMITING", originalRedisRateLimiting],
    ["INFERENCE_HOT_PATH_CACHES", originalHotPathCaches],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

let n = 0;
const uid = () => `org-${++n}`;

describe("enforceOrgRateLimit lease (#9899 Tier-3)", () => {
  beforeEach(() => {
    process.env.REDIS_RATE_LIMITING = "true";
    process.env.INFERENCE_HOT_PATH_CACHES = "true";
    __clearOrgRateLimitLeases();
    redisChecks = 0;
    tierReads = 0;
    carriedCounts = [];
    simulateWindow = false;
    windowCount = 0;
    tierConfig = { windowMs: 60_000, maxRequests: 120 };
    redisResult = {
      allowed: true,
      remaining: 100,
      resetAt: Date.now() + 60_000,
    };
  });

  test("REDIS_RATE_LIMITING off skips both the lease and Redis entirely", async () => {
    process.env.REDIS_RATE_LIMITING = "false";
    expect(await enforceOrgRateLimit(uid(), "completions")).toBeNull();
    expect(redisChecks).toBe(0);
    expect(tierReads).toBe(0);
  });

  test("INFERENCE_HOT_PATH_CACHES off = no lease: every request is authoritative (today's behavior)", async () => {
    process.env.INFERENCE_HOT_PATH_CACHES = "false";
    const org = uid();
    for (let i = 0; i < 4; i++) {
      expect(await enforceOrgRateLimit(org, "completions")).toBeNull();
    }
    expect(redisChecks).toBe(4);
    expect(carriedCounts).toEqual([0, 0, 0, 0]);
  });

  test("first request is authoritative; repeats within the lease budget skip Redis", async () => {
    const org = uid();
    expect(await enforceOrgRateLimit(org, "completions")).toBeNull();
    expect(redisChecks).toBe(1);
    expect(tierReads).toBe(1);

    for (let i = 0; i < 5; i++) {
      expect(await enforceOrgRateLimit(org, "completions")).toBeNull();
    }
    // 120 rpm × 5s/60s window → local budget 10; 5 repeats fit in it.
    expect(redisChecks).toBe(1);
    expect(tierReads).toBe(1);
  });

  test("leases are keyed per (org, endpoint) — a different org or endpoint is authoritative", async () => {
    const org = uid();
    await enforceOrgRateLimit(org, "completions");
    await enforceOrgRateLimit(org, "embeddings");
    await enforceOrgRateLimit(uid(), "completions");
    expect(redisChecks).toBe(3);
  });

  test("an exhausted local budget forces a fresh authoritative check that CARRIES the leased count into the window", async () => {
    const org = uid();
    // remaining=3 < pro-rated share → budget 3.
    redisResult = { allowed: true, remaining: 3, resetAt: Date.now() + 60_000 };
    await enforceOrgRateLimit(org, "completions"); // authoritative (carried 0)
    await enforceOrgRateLimit(org, "completions"); // lease 1/3
    await enforceOrgRateLimit(org, "completions"); // lease 2/3
    await enforceOrgRateLimit(org, "completions"); // lease 3/3
    expect(redisChecks).toBe(1);
    await enforceOrgRateLimit(org, "completions"); // budget spent → authoritative
    expect(redisChecks).toBe(2);
    // The 3 leased requests were flushed into the sliding window.
    expect(carriedCounts).toEqual([0, 3]);
  });

  test("a denial is leased: repeats within the TTL 429 without another Redis round-trip", async () => {
    const org = uid();
    redisResult = {
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 30_000,
      retryAfter: 30,
    };
    const first = await enforceOrgRateLimit(org, "completions");
    expect(first?.status).toBe(429);
    expect(redisChecks).toBe(1);

    const second = await enforceOrgRateLimit(org, "completions");
    expect(second?.status).toBe(429);
    expect(redisChecks).toBe(1);
    const body = (await second?.json()) as { code?: string; retryAfter?: number };
    expect(body.code).toBe("rate_limit_exceeded");
    expect(body.retryAfter).toBe(30);
  });

  test("an allowed result with zero remaining never leases (next request is authoritative)", async () => {
    const org = uid();
    redisResult = { allowed: true, remaining: 0, resetAt: Date.now() + 60_000 };
    await enforceOrgRateLimit(org, "completions");
    await enforceOrgRateLimit(org, "completions");
    expect(redisChecks).toBe(2);
  });

  test("D1 convergence: a hot isolate cannot exceed the org limit by more than one in-flight lease budget", async () => {
    // Real-window simulation: carried members count like live appends. Limit
    // 120/60s → lease budget ceil(120×5/60) = 10. Drive far more traffic than
    // the limit and count what was actually ALLOWED.
    simulateWindow = true;
    const org = uid();
    const maxRequests = tierConfig.maxRequests; // 120
    const budget = Math.ceil((maxRequests * 5_000) / 60_000); // 10

    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < maxRequests * 5; i++) {
      const res = await enforceOrgRateLimit(org, "completions");
      if (res === null) allowed++;
      else denied++;
    }

    // The org limit itself still flows, and the overshoot is bounded by ONE
    // in-flight lease budget — never the sustained ~(1+B)× the lossy lease had.
    expect(allowed).toBeGreaterThanOrEqual(maxRequests);
    expect(allowed).toBeLessThanOrEqual(maxRequests + budget);
    expect(denied).toBe(maxRequests * 5 - allowed);
    // The window converged to the true count: every allowed request was
    // appended (authoritative members + flushed carries), minus at most the
    // one in-flight budget not yet flushed.
    expect(windowCount).toBeGreaterThanOrEqual(allowed - budget);
  });
});
