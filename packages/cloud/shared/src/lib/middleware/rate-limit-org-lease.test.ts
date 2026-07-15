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
import { createHash } from "node:crypto";
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
let pauseRedisChecks = false;
const redisCheckWaiters: Array<() => void> = [];
let redisKeys: string[] = [];

async function waitForRedisWaiters(count: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (redisCheckWaiters.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${count} paused Redis checks`);
}

mock.module("./rate-limit-redis", () => ({
  ...rateLimitRedisActual,
  checkRateLimitRedis: async (
    key: string,
    _windowMs: number,
    maxRequests: number,
    options?: { carriedCount?: number },
  ) => {
    redisChecks++;
    redisKeys.push(key);
    const carried = options?.carriedCount ?? 0;
    carriedCounts.push(carried);
    if (pauseRedisChecks) {
      await new Promise<void>((resolve) => redisCheckWaiters.push(resolve));
    }
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

const {
  enforceOrgRateLimit,
  __clearOrgRateLimitLeases,
  checkCostBasedRateLimit,
  checkRateLimitAsync,
  enforceMcpOrganizationRateLimit,
  mcpOrgRateLimitRedisKey,
  rateLimitExceededPayload,
  rateLimitExceededResponse,
  withRateLimit,
} = await import("./rate-limit");

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
    redisKeys = [];
    tierReads = 0;
    carriedCounts = [];
    pauseRedisChecks = false;
    redisCheckWaiters.length = 0;
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

  test("concurrent authoritative checks claim the carry once and cannot publish a stale replacement lease (#15415)", async () => {
    const org = uid();
    // remaining=1 < pro-rated share → one leased serve, then every concurrent
    // request after it falls through to Redis.
    redisResult = { allowed: true, remaining: 1, resetAt: Date.now() + 60_000 };
    await enforceOrgRateLimit(org, "completions"); // authoritative (carried 0)
    await enforceOrgRateLimit(org, "completions"); // lease 1/1
    expect(redisChecks).toBe(1);

    pauseRedisChecks = true;
    const owner = enforceOrgRateLimit(org, "completions");
    const nonOwner = enforceOrgRateLimit(org, "completions");
    await waitForRedisWaiters(2);

    // The first fallthrough claims and resets the carry synchronously. The
    // second fallthrough still performs its own authoritative check, but it
    // must not append the same leased request again.
    expect(carriedCounts).toEqual([0, 1, 0]);

    // Let the non-owner return first. If it publishes a replacement lease, the
    // next request below would serve from that stale lease and skip Redis.
    redisCheckWaiters[1]();
    expect(await nonOwner).toBeNull();
    expect(redisChecks).toBe(3);

    const whileOwnerInFlight = enforceOrgRateLimit(org, "completions");
    await waitForRedisWaiters(3);
    expect(redisChecks).toBe(4);
    expect(carriedCounts).toEqual([0, 1, 0, 0]);

    redisCheckWaiters[0]();
    redisCheckWaiters[2]();
    expect(await owner).toBeNull();
    expect(await whileOwnerInFlight).toBeNull();
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

  test("turning the lease flag off flushes pending local usage before dropping the lease", async () => {
    const org = uid();
    redisResult = { allowed: true, remaining: 3, resetAt: Date.now() + 60_000 };

    await enforceOrgRateLimit(org, "completions"); // authoritative
    await enforceOrgRateLimit(org, "completions"); // locally leased
    expect(redisChecks).toBe(1);

    process.env.INFERENCE_HOT_PATH_CACHES = "false";
    await enforceOrgRateLimit(org, "completions");
    expect(redisChecks).toBe(2);
    expect(carriedCounts).toEqual([0, 1]);

    // The old lease was dropped, so switching the feature back on starts with
    // another authoritative decision instead of reviving stale local budget.
    process.env.INFERENCE_HOT_PATH_CACHES = "true";
    await enforceOrgRateLimit(org, "completions");
    expect(redisChecks).toBe(3);
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

describe("public rate-limit contracts", () => {
  beforeEach(() => {
    process.env.REDIS_RATE_LIMITING = "false";
    redisChecks = 0;
    redisKeys = [];
    simulateWindow = false;
    windowCount = 0;
    redisResult = {
      allowed: true,
      remaining: 99,
      resetAt: Date.now() + 60_000,
    };
  });

  test("hashes stable credentials before a Redis-backed decision", async () => {
    process.env.REDIS_RATE_LIMITING = "true";
    const apiKey = "eliza_secret-api-key";
    const result = await checkRateLimitAsync(
      new Request("https://api.example.test", {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
      { windowMs: 60_000, maxRequests: 100 },
    );

    expect(result.allowed).toBe(true);
    expect(redisKeys).toEqual([`apikey:${createHash("sha256").update(apiKey).digest("hex")}`]);
    expect(redisKeys[0]).not.toContain(apiKey);
  });

  test("in-memory async checks and wrapped handlers enforce one shared bucket", async () => {
    const key = `public-contract-${uid()}`;
    const config = { windowMs: 60_000, maxRequests: 2, keyGenerator: () => key };
    const request = new Request("https://api.example.test");

    expect((await checkRateLimitAsync(request, config)).remaining).toBe(1);

    const wrapped = withRateLimit(
      async () => new Response("ok", { status: 201, headers: { "X-Origin": "handler" } }),
      config,
    );
    const allowed = await wrapped(request);
    expect(allowed.status).toBe(201);
    expect(allowed.headers.get("X-Origin")).toBe("handler");
    expect(allowed.headers.get("X-RateLimit-Policy")).toBe("in-memory");

    const denied = await wrapped(request);
    expect(denied.status).toBe(429);
    expect(await denied.json()).toMatchObject({
      code: "rate_limit_exceeded",
      retryAfter: 60,
    });
  });

  test("dynamic wrapped handlers receive their route context", async () => {
    const key = `dynamic-contract-${uid()}`;
    const wrapped = withRateLimit<{ id: string }>(
      async (_request, context) => Response.json({ id: (await context.params).id }),
      { windowMs: 60_000, maxRequests: 1, keyGenerator: () => key },
    );

    const response = await wrapped(new Request("https://api.example.test"), {
      params: Promise.resolve({ id: "route-id" }),
    });
    expect(await response.json()).toEqual({ id: "route-id" });
  });

  test("MCP keys and denial responses preserve the shared response contract", async () => {
    expect(mcpOrgRateLimitRedisKey("org-1")).toBe("mcp:ratelimit:org-1");
    expect(mcpOrgRateLimitRedisKey("org-1", "github")).toBe("mcp:ratelimit:github:org-1");

    redisResult = {
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 30_000,
      retryAfter: 30,
    };
    const response = await enforceMcpOrganizationRateLimit("org-1", "github");
    expect(redisKeys).toEqual(["mcp:ratelimit:github:org-1"]);
    expect(response?.status).toBe(429);
    expect(await response?.json()).toMatchObject({
      code: "rate_limit_exceeded",
      retryAfter: 30,
    });

    const payload = rateLimitExceededPayload(redisResult, 100, 60_000, "redis");
    expect(payload.headers["X-RateLimit-Policy"]).toBe("redis");
    expect(payload.body.message).toContain("Maximum 100 requests");
    expect(rateLimitExceededResponse(redisResult, 100, 60_000, "redis").status).toBe(429);
  });

  test("cost limits accumulate sync and async costs without crossing identities", async () => {
    const session = `cost-${uid()}`;
    const request = new Request("https://api.example.test", {
      headers: { "x-anonymous-session": session },
    });
    const config = {
      windowMs: 60_000,
      maxCost: 5,
      getCost: async () => 3,
    };

    const first = await checkCostBasedRateLimit(request, config);
    const second = await checkCostBasedRateLimit(request, config);
    expect(first).toMatchObject({ allowed: true, remaining: 2 });
    expect(second.allowed).toBe(false);
    expect(second.retryAfter).toBe(60);

    const otherIdentity = await checkCostBasedRateLimit(
      new Request("https://api.example.test", {
        headers: { "x-anonymous-session": `${session}-other` },
      }),
      config,
    );
    expect(otherIdentity.allowed).toBe(true);
  });
});
