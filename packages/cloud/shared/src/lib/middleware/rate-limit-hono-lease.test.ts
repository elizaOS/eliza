/**
 * Focused coverage for the Hono rate-limit in-isolate lease used on the
 * inference gateway hot path. The Redis client is fake, but the Hono middleware
 * and lease accounting are real: flag-off behavior stays authoritative, repeat
 * allowed decisions skip Redis, carried usage flushes into the next Redis
 * check, and denials lease without repeated backend round-trips.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as loggerActual from "../utils/logger";

class FakeRedis {
  count = 0;
  incrCalls = 0;
  expireCalls = 0;
  pipelineExecCalls = 0;
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

  pipeline() {
    const operations: Array<"incr" | "pttl"> = [];
    const pipeline = {
      incr: () => {
        operations.push("incr");
        return pipeline;
      },
      pttl: () => {
        operations.push("pttl");
        return pipeline;
      },
      exec: async () => {
        this.pipelineExecCalls++;
        const results: number[] = [];
        for (const operation of operations) {
          results.push(operation === "incr" ? await this.incr() : await this.pttl());
        }
        return results;
      },
    };
    return pipeline;
  }
}

const redis = new FakeRedis();

mock.module("../utils/logger", () => ({
  ...loggerActual,
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { rateLimit, _resetHonoRateLimitLeases } = await import("./rate-limit-hono-cloudflare");

afterAll(() => {
  mock.module("../utils/logger", () => loggerActual);
});

const BASE_ENV = {
  NODE_ENV: "production",
  REDIS_RATE_LIMITING: "true",
  REDIS_URL: "redis://mock:6379",
};

function makeApp(config: Parameters<typeof rateLimit>[0]) {
  const app = new Hono();
  app.use(rateLimit(config, undefined, { buildRedisClient: () => redis }));
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
    redis.pipelineExecCalls = 0;
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
    expect(redis.pipelineExecCalls).toBe(4);
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
    expect(redis.pipelineExecCalls).toBe(2);
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
