/**
 * MONEY limiter policy (#22982): caller options cannot weaken fail-closed
 * shared-Redis enforcement, and mixed middleware cannot overwrite the
 * money response.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as loggerActual from "../utils/logger";

class FakeRedis {
  counts = new Map<string, number>();
  throwNext = false;

  async incr(key = "default"): Promise<number> {
    if (this.throwNext) throw new Error("ECONNREFUSED: redis down");
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  async pttl(): Promise<number> {
    if (this.throwNext) throw new Error("ECONNREFUSED: redis down");
    return 60_000;
  }

  async pexpire(): Promise<number> {
    if (this.throwNext) throw new Error("ECONNREFUSED: redis down");
    return 1;
  }

  pipeline() {
    const operations: Array<{ op: "incr" | "pttl"; key: string }> = [];
    const pipeline = {
      incr: (key = "default") => {
        operations.push({ op: "incr", key });
        return pipeline;
      },
      pttl: (key = "default") => {
        operations.push({ op: "pttl", key });
        return pipeline;
      },
      exec: async () => {
        const results: number[] = [];
        for (const operation of operations) {
          results.push(
            operation.op === "incr" ? await this.incr(operation.key) : await this.pttl(),
          );
        }
        return results;
      },
    };
    return pipeline;
  }
}

const redis = new FakeRedis();
const handler = mock(async (c: { json: (body: unknown) => Response }) => c.json({ ok: true }));

mock.module("../utils/logger", () => ({
  ...loggerActual,
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const {
  RateLimitPresets,
  moneyRateLimit,
  moneyRateLimitConfig,
  rateLimit,
  _resetHonoRateLimitLeases,
} = await import("./rate-limit-hono-cloudflare");

afterAll(() => {
  mock.module("../utils/logger", () => loggerActual);
});

const ENV = {
  NODE_ENV: "production",
  REDIS_RATE_LIMITING: "true",
  REDIS_URL: "redis://mock:6379",
  INFERENCE_HOT_PATH_CACHES: "true",
};

function req() {
  return new Request("https://api.example.test/pay", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.9" },
  });
}

describe("moneyRateLimitConfig (#22982)", () => {
  test("preserves window and key while forcing fail-closed no-lease flags", () => {
    const keyGenerator = () => "org:1";
    const config = moneyRateLimitConfig({
      ...RateLimitPresets.CRITICAL,
      keyGenerator,
      failClosed: false,
      localLease: true,
      redisUnavailableFallback: { namespace: "must-not-survive" },
    });

    expect(config.windowMs).toBe(RateLimitPresets.CRITICAL.windowMs);
    expect(config.maxRequests).toBe(RateLimitPresets.CRITICAL.maxRequests);
    expect(config.keyGenerator).toBe(keyGenerator);
    expect(config.failClosed).toBe(true);
    expect(config.localLease).toBe(false);
    expect(config.redisUnavailableFallback).toBeUndefined();
  });
});

describe("moneyRateLimit runtime contract (#22982)", () => {
  beforeEach(() => {
    redis.counts.clear();
    redis.throwNext = false;
    handler.mockClear();
    _resetHonoRateLimitLeases();
  });

  test("missing Redis client returns 503 with Retry-After and skips the handler", async () => {
    const app = new Hono();
    app.post(
      "/pay",
      moneyRateLimit(RateLimitPresets.STRICT, undefined, {
        buildRedisClient: () => null,
      }),
      (c) => handler(c),
    );

    const res = await app.fetch(req(), ENV);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    await expect(res.json()).resolves.toMatchObject({
      code: "rate_limit_unavailable",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("Redis constructor failure returns 503 and skips the handler", async () => {
    const app = new Hono();
    app.post(
      "/pay",
      moneyRateLimit(RateLimitPresets.STRICT, undefined, {
        buildRedisClient: () => {
          throw new Error("invalid Redis URL");
        },
      }),
      (c) => handler(c),
    );

    const res = await app.fetch(req(), ENV);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(handler).not.toHaveBeenCalled();
  });

  test("runtime Redis exception returns 503 and skips the handler", async () => {
    redis.throwNext = true;
    const app = new Hono();
    app.post(
      "/pay",
      moneyRateLimit(RateLimitPresets.STRICT, undefined, {
        buildRedisClient: () => redis,
      }),
      (c) => handler(c),
    );

    const res = await app.fetch(req(), ENV);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(handler).not.toHaveBeenCalled();
  });

  test("healthy Redis is consulted every request and exhausted windows return 429", async () => {
    const app = new Hono();
    app.post(
      "/pay",
      moneyRateLimit({ windowMs: 60_000, maxRequests: 1 }, undefined, {
        buildRedisClient: () => redis,
      }),
      (c) => handler(c),
    );

    const first = await app.fetch(req(), ENV);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-RateLimit-Policy")).toBe("redis");
    expect(handler).toHaveBeenCalledTimes(1);

    const second = await app.fetch(req(), ENV);
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBeTruthy();
    await expect(second.json()).resolves.toMatchObject({
      code: "rate_limit_exceeded",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect([...redis.counts.values()].reduce((sum, n) => sum + n, 0)).toBe(2);
  });

  test("hot-path caches cannot serve a stale allow after Redis dies", async () => {
    const app = new Hono();
    app.post(
      "/pay",
      moneyRateLimit({ windowMs: 60_000, maxRequests: 20 }, undefined, {
        buildRedisClient: () => redis,
      }),
      (c) => handler(c),
    );

    const first = await app.fetch(req(), ENV);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-RateLimit-Policy")).toBe("redis");

    redis.throwNext = true;
    const second = await app.fetch(req(), ENV);
    expect(second.status).toBe(503);
    expect(second.headers.get("X-RateLimit-Policy")).not.toBe("redis-lease");
    expect(second.headers.get("Retry-After")).toBe("30");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("an outer fall-open limiter cannot overwrite MONEY 429 status or Retry-After", async () => {
    const app = new Hono();
    app.use(
      "*",
      rateLimit(
        {
          ...RateLimitPresets.RELAXED,
          maxRequests: 200,
          keyGenerator: () => "outer",
        },
        undefined,
        { buildRedisClient: () => redis },
      ),
    );
    app.post(
      "/pay",
      moneyRateLimit(
        {
          windowMs: 60_000,
          maxRequests: 1,
          keyGenerator: () => "inner",
        },
        undefined,
        { buildRedisClient: () => redis },
      ),
      (c) => handler(c),
    );

    expect((await app.fetch(req(), ENV)).status).toBe(200);
    const denied = await app.fetch(req(), ENV);
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBeTruthy();
    expect(denied.headers.get("X-RateLimit-Limit")).toBe("1");
    await expect(denied.json()).resolves.toMatchObject({
      code: "rate_limit_exceeded",
    });
  });
});
