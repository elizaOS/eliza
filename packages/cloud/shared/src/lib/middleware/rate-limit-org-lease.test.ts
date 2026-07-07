/**
 * Unit tests for the Tier-3 in-isolate decision lease in `enforceOrgRateLimit`
 * (#9899). The Redis check and the org-tier read are mocked at the module
 * boundary so the tests can count authoritative round-trips; the lease logic
 * under test is real.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as orgRateLimitsActual from "../services/org-rate-limits";
import * as rateLimitRedisActual from "./rate-limit-redis";

let redisChecks = 0;
let redisResult: rateLimitRedisActual.RateLimitResult;
let tierReads = 0;

mock.module("./rate-limit-redis", () => ({
  ...rateLimitRedisActual,
  checkRateLimitRedis: async () => {
    redisChecks++;
    return redisResult;
  },
}));

mock.module("../services/org-rate-limits", () => ({
  ...orgRateLimitsActual,
  getOrgRpmForEndpoint: async () => {
    tierReads++;
    return { windowMs: 60_000, maxRequests: 120 };
  },
}));

const { enforceOrgRateLimit, __clearOrgRateLimitLeases } = await import("./rate-limit");

const originalRedisRateLimiting = process.env.REDIS_RATE_LIMITING;

afterAll(() => {
  mock.module("./rate-limit-redis", () => rateLimitRedisActual);
  mock.module("../services/org-rate-limits", () => orgRateLimitsActual);
  if (originalRedisRateLimiting === undefined) {
    delete process.env.REDIS_RATE_LIMITING;
  } else {
    process.env.REDIS_RATE_LIMITING = originalRedisRateLimiting;
  }
});

let n = 0;
const uid = () => `org-${++n}`;

describe("enforceOrgRateLimit lease (#9899 Tier-3)", () => {
  beforeEach(() => {
    process.env.REDIS_RATE_LIMITING = "true";
    __clearOrgRateLimitLeases();
    redisChecks = 0;
    tierReads = 0;
    redisResult = {
      allowed: true,
      remaining: 100,
      resetAt: Date.now() + 60_000,
    };
  });

  test("flag off skips both the lease and Redis entirely", async () => {
    process.env.REDIS_RATE_LIMITING = "false";
    expect(await enforceOrgRateLimit(uid(), "completions")).toBeNull();
    expect(redisChecks).toBe(0);
    expect(tierReads).toBe(0);
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

  test("an exhausted local budget forces a fresh authoritative check", async () => {
    const org = uid();
    // remaining=3 < pro-rated share → budget 3.
    redisResult = { allowed: true, remaining: 3, resetAt: Date.now() + 60_000 };
    await enforceOrgRateLimit(org, "completions"); // authoritative (1)
    await enforceOrgRateLimit(org, "completions"); // lease 1/3
    await enforceOrgRateLimit(org, "completions"); // lease 2/3
    await enforceOrgRateLimit(org, "completions"); // lease 3/3
    expect(redisChecks).toBe(1);
    await enforceOrgRateLimit(org, "completions"); // budget spent → authoritative (2)
    expect(redisChecks).toBe(2);
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
});
