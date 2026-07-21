/**
 * Rate limiter fail-closed behavior on a runtime Redis error (#12227 M11).
 *
 * The limiter falls OPEN on a Redis error at request time — correct for
 * ordinary routes (a store outage shouldn't 500 the app). Sensitive routes must
 * either fail CLOSED (top-up) or install an explicit local fallback limiter
 * (steward-session mint) so a Redis outage never becomes unlimited traffic.
 *
 * The Redis DEPENDENCY is mocked to simulate the outage (that outage is the
 * condition under test); the real `rateLimit` middleware logic runs.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as loggerActual from "../utils/logger";

const loggerError = mock(() => undefined);
const loggerWarn = mock(() => undefined);

mock.module("@elizaos/cloud-routing", () => ({}));
mock.module("../utils/logger", () => ({
  ...loggerActual,
  logger: {
    debug: mock(() => undefined),
    error: loggerError,
    info: mock(() => undefined),
    warn: loggerWarn,
  },
}));

// Simulate a Redis backend that is present (getRedis returns a client) but
// throws on every op — i.e. a runtime outage, not a "not configured" state.
const throwingRedis = {
  incr: async () => {
    throw new Error("ECONNREFUSED: redis down");
  },
  pttl: async () => {
    throw new Error("ECONNREFUSED: redis down");
  },
  pexpire: async () => {
    throw new Error("ECONNREFUSED: redis down");
  },
  pipeline: () => {
    const pipeline = {
      incr: () => pipeline,
      pttl: () => pipeline,
      exec: async () => {
        throw new Error("ECONNREFUSED: redis down");
      },
    };
    return pipeline;
  },
};

const {
  rateLimit,
  RateLimitPresets,
  getIpKey,
  _checkRedisUnavailableFallback,
  _redisUnavailableFallbackBucketCount,
  _redisUnavailableFallbackMaxKeys,
  _resetRedisUnavailableFallbackBuckets,
} = await import("./rate-limit-hono-cloudflare");

// A configured, non-disabled env so getRedis returns the (throwing) client.
const ENV = { REDIS_URL: "redis://mock:6379", NODE_ENV: "production" };

function appWith(config: Parameters<typeof rateLimit>[0]) {
  return appWithBuilder(config, () => throwingRedis);
}

function appWithBuilder(
  config: Parameters<typeof rateLimit>[0],
  buildRedisClient: NonNullable<Parameters<typeof rateLimit>[2]>["buildRedisClient"],
) {
  const app = new Hono();
  app.use(rateLimit(config, undefined, { buildRedisClient }));
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

function req() {
  return new Request("https://api.example.test/", {
    method: "GET",
    headers: { "cf-connecting-ip": "203.0.113.7" },
  });
}

afterAll(() => {
  mock.module("../utils/logger", () => loggerActual);
  mock.restore();
});

beforeEach(() => {
  _resetRedisUnavailableFallbackBuckets();
  loggerError.mockClear();
  loggerWarn.mockClear();
});

describe("rateLimit — fail-closed vs fall-open on runtime Redis error (M11)", () => {
  test("fail-closed route rejects when no Redis client can be constructed", async () => {
    const app = appWithBuilder(
      {
        ...RateLimitPresets.STRICT,
        keyGenerator: getIpKey,
        failClosed: true,
      },
      () => null,
    );

    const res = await app.fetch(req(), ENV);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(loggerError).toHaveBeenCalledWith(
      "[RateLimit] Redis client unavailable on fail-closed route; rejecting",
      { error: "Redis client is not configured" },
    );
  });

  test("a Redis constructor failure follows fail-closed policy with an observable cause", async () => {
    const app = appWithBuilder(
      {
        ...RateLimitPresets.STRICT,
        keyGenerator: getIpKey,
        failClosed: true,
      },
      () => {
        throw new Error("invalid Redis URL");
      },
    );

    const res = await app.fetch(req(), ENV);
    expect(res.status).toBe(503);
    expect(loggerError).toHaveBeenCalledWith(
      "[RateLimit] Redis client unavailable on fail-closed route; rejecting",
      { error: "invalid Redis URL" },
    );
  });

  test("a Redis constructor failure falls open visibly on an ordinary route", async () => {
    const app = appWithBuilder(RateLimitPresets.STANDARD, () => {
      throw new Error("invalid Redis URL");
    });

    const res = await app.fetch(req(), ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Policy")).toBe("redis-unavailable");
    expect(loggerWarn).toHaveBeenCalledWith(
      "[RateLimit] Redis client construction failed; falling open",
      { error: "invalid Redis URL" },
    );
  });

  test("fail-closed route rejects with 503 when Redis throws", async () => {
    const app = appWith({
      ...RateLimitPresets.STRICT,
      keyGenerator: getIpKey,
      failClosed: true,
    });
    const res = await app.fetch(req(), ENV);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      code: "rate_limit_unavailable",
    });
  });

  test("a normal (fall-open) route still serves 200 when Redis throws", async () => {
    const app = appWith({ ...RateLimitPresets.STANDARD });
    const res = await app.fetch(req(), ENV);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    // and it advertises the degraded policy rather than pretending it enforced.
    expect(res.headers.get("X-RateLimit-Policy")).toBe("redis-unavailable");
  });

  test("a route with a Redis-outage fallback stays available but locally throttled", async () => {
    const app = appWith({
      ...RateLimitPresets.STRICT,
      keyGenerator: getIpKey,
      redisUnavailableFallback: {
        namespace: "test-fallback",
        maxRequests: 2,
      },
      failClosed: true,
    });

    const first = await app.fetch(req(), ENV);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-RateLimit-Policy")).toBe("redis-unavailable-local");

    const second = await app.fetch(req(), ENV);
    expect(second.status).toBe(200);

    const third = await app.fetch(req(), ENV);
    expect(third.status).toBe(429);
    await expect(third.json()).resolves.toMatchObject({
      success: false,
      code: "rate_limit_exceeded",
    });
    expect(third.headers.get("X-RateLimit-Policy")).toBe("redis-unavailable-local");
  });

  test("a missing Redis client activates the configured local fallback", async () => {
    const app = appWithBuilder(
      {
        ...RateLimitPresets.STRICT,
        keyGenerator: getIpKey,
        redisUnavailableFallback: {
          namespace: "missing-client-fallback",
          maxRequests: 2,
        },
        failClosed: true,
      },
      () => null,
    );

    const first = await app.fetch(req(), ENV);
    const second = await app.fetch(req(), ENV);
    const third = await app.fetch(req(), ENV);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(first.headers.get("X-RateLimit-Policy")).toBe("redis-unavailable-local");
    expect(third.headers.get("X-RateLimit-Policy")).toBe("redis-unavailable-local");
  });

  test("the outage fallback stays bounded under adversarial key cardinality", () => {
    const now = 10_000;
    const config = {
      ...RateLimitPresets.STRICT,
      redisUnavailableFallback: {
        namespace: "bounded-fallback",
        maxRequests: 2,
      },
    };
    for (let index = 0; index < _redisUnavailableFallbackMaxKeys; index += 1) {
      _checkRedisUnavailableFallback(`ip:${index}`, config, now);
    }
    expect(_redisUnavailableFallbackBucketCount()).toBe(_redisUnavailableFallbackMaxKeys);

    // Refresh key zero before a new key forces eviction; the LRU bucket, not
    // this hot bucket, must be discarded.
    _checkRedisUnavailableFallback("ip:0", config, now + 1);
    _checkRedisUnavailableFallback("ip:overflow", config, now + 1);
    expect(_redisUnavailableFallbackBucketCount()).toBe(_redisUnavailableFallbackMaxKeys);
    expect(_checkRedisUnavailableFallback("ip:0", config, now + 2).allowed).toBe(false);

    _checkRedisUnavailableFallback(
      "ip:after-expiry",
      config,
      now + RateLimitPresets.STRICT.windowMs + 1,
    );
    expect(_redisUnavailableFallbackBucketCount()).toBe(1);
  });
});
