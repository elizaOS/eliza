/**
 * Focused coverage for the Hono rate-limit in-isolate lease used on the
 * inference gateway hot path. The Redis client is fake, but the Hono middleware
 * and lease accounting are real: flag-off behavior stays authoritative, repeat
 * allowed decisions skip Redis, carried usage flushes into the next Redis
 * check, and denials lease without repeated backend round-trips.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

class FakeRedis {
  count = 0;
  incrCalls = 0;
  expireCalls = 0;
  ttl = -1;

  async incr(): Promise<number> {
    this.incrCalls++;
    this.count++;
    return this.count;
  }

  async pttl(): Promise<number> {
    return this.ttl;
  }

  async pexpire(_key: string, windowMs: number): Promise<number> {
    this.expireCalls++;
    this.ttl = windowMs;
    return 1;
  }
}

const redis = new FakeRedis();

mock.module("../cache/redis-factory", () => ({
  buildRedisClient: () => redis,
  hasRedisConfig: () => true,
  isCloudflareWorkerRuntime: () => false,
}));

mock.module("../utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { rateLimit, _resetHonoRateLimitLeases } = await import("./rate-limit-hono-cloudflare");

const BASE_ENV = {
  NODE_ENV: "production",
  REDIS_RATE_LIMITING: "true",
  REDIS_URL: "redis://mock:6379",
};

function makeApp(config: Parameters<typeof rateLimit>[0]) {
  const app = new Hono();
  app.use(rateLimit(config));
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

function req(id = "client-a") {
  return new Request("https://api.example.test/", {
    headers: { "x-api-key": `eliza_${id}` },
  });
}

describe("Hono rateLimit lease (#15428)", () => {
  beforeEach(() => {
    redis.count = 0;
    redis.incrCalls = 0;
    redis.expireCalls = 0;
    redis.ttl = -1;
    _resetHonoRateLimitLeases();
  });

  test("INFERENCE_HOT_PATH_CACHES off keeps every request authoritative", async () => {
    const app = makeApp({ windowMs: 60_000, maxRequests: 20 });
    const env = { ...BASE_ENV, INFERENCE_HOT_PATH_CACHES: "false" };

    for (let i = 0; i < 4; i++) {
      const res = await app.fetch(req(), env);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Policy")).toBe("redis");
    }

    expect(redis.incrCalls).toBe(4);
  });

  test("flag-on repeats within budget skip Redis and advertise the lease policy", async () => {
    const app = makeApp({ windowMs: 60_000, maxRequests: 60 });
    const env = { ...BASE_ENV, INFERENCE_HOT_PATH_CACHES: "true" };

    const first = await app.fetch(req(), env);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-RateLimit-Policy")).toBe("redis");
    expect(redis.incrCalls).toBe(1);

    for (let i = 0; i < 3; i++) {
      const res = await app.fetch(req(), env);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Policy")).toBe("redis-lease");
    }

    expect(redis.incrCalls).toBe(1);
  });

  test("spent local budget carries leased requests into the next Redis check", async () => {
    const app = makeApp({ windowMs: 10_000, maxRequests: 4 });
    const env = { ...BASE_ENV, INFERENCE_HOT_PATH_CACHES: "true" };

    expect((await app.fetch(req(), env)).status).toBe(200); // authoritative
    expect((await app.fetch(req(), env)).headers.get("X-RateLimit-Policy")).toBe("redis-lease");
    expect((await app.fetch(req(), env)).headers.get("X-RateLimit-Policy")).toBe("redis-lease");
    expect(redis.incrCalls).toBe(1);

    const flushed = await app.fetch(req(), env);
    expect(flushed.status).toBe(200);
    expect(flushed.headers.get("X-RateLimit-Policy")).toBe("redis");

    // First authoritative hit + two carried INCRs + current authoritative hit.
    expect(redis.incrCalls).toBe(4);
  });

  test("denials are leased instead of hammering Redis", async () => {
    const app = makeApp({ windowMs: 60_000, maxRequests: 1 });
    const env = { ...BASE_ENV, INFERENCE_HOT_PATH_CACHES: "true" };

    expect((await app.fetch(req(), env)).status).toBe(200);
    expect(redis.incrCalls).toBe(1);

    const denied = await app.fetch(req(), env);
    expect(denied.status).toBe(429);
    expect(denied.headers.get("X-RateLimit-Policy")).toBe("redis");
    expect(redis.incrCalls).toBe(2);

    const leasedDenied = await app.fetch(req(), env);
    expect(leasedDenied.status).toBe(429);
    expect(leasedDenied.headers.get("X-RateLimit-Policy")).toBe("redis-lease");
    expect(redis.incrCalls).toBe(2);
  });
});
