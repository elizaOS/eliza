/**
 * Selection-logic regression tests for `createRedis()`.
 *
 * Wave 4a wired a `MOCK_REDIS=1` opt-in. These tests pin the priority:
 *
 *   1. MOCK_REDIS=1               → MemoryRedisAdapter
 *   2. KV_REST_API_URL + token    → UpstashRedis (REST)
 *   3. REDIS_URL                  → NativeRedisAdapter (ioredis)
 *   4. nothing set                → throws
 *
 * Note this package's priority differs from cloud-shared/redis-factory:
 * Upstash REST wins over REDIS_URL here. That is intentional in the source
 * (gateway-webhook talks to Upstash from Cloudflare Workers in prod) and we
 * lock it in.
 *
 * We mock `ioredis` so `new IORedis(url)` does not open a real TCP socket
 * during the native-path test.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

class FakeIORedis {
  constructor(public readonly url: string) {}
  get() {
    return Promise.resolve(null);
  }
  set() {
    return Promise.resolve("OK");
  }
  lpush() {
    return Promise.resolve(1);
  }
  ltrim() {
    return Promise.resolve("OK");
  }
  expire() {
    return Promise.resolve(1);
  }
  quit() {
    return Promise.resolve("OK");
  }
}

mock.module("ioredis", () => ({
  default: FakeIORedis,
}));

const PREV = {
  MOCK_REDIS: process.env.MOCK_REDIS,
  KV_REST_API_URL: process.env.KV_REST_API_URL,
  KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  REDIS_URL: process.env.REDIS_URL,
};

function clearEnv() {
  delete process.env.MOCK_REDIS;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.REDIS_URL;
}

beforeEach(() => {
  clearEnv();
});

afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("gateway-webhook createRedis selection", () => {
  test("MOCK_REDIS=1 → in-memory adapter (even when Upstash + REDIS_URL set)", async () => {
    process.env.MOCK_REDIS = "1";
    process.env.KV_REST_API_URL = "https://example.upstash.io";
    process.env.KV_REST_API_TOKEN = "ignored";
    process.env.REDIS_URL = "redis://ignored:6379";

    const { createRedis } = await import("../redis");
    const redis = createRedis();
    expect(redis.constructor.name).toBe("MemoryRedisAdapter");
  });

  test("Upstash creds (no MOCK_REDIS) → UpstashRedis REST client", async () => {
    process.env.KV_REST_API_URL = "https://example.upstash.io";
    process.env.KV_REST_API_TOKEN = "real-token";

    const { createRedis } = await import("../redis");
    const { Redis: UpstashRedis } = await import("@upstash/redis");
    const redis = createRedis();
    expect(redis).toBeInstanceOf(UpstashRedis);
  });

  test("REDIS_URL only (no MOCK_REDIS, no Upstash) → NativeRedisAdapter (ioredis)", async () => {
    process.env.REDIS_URL = "redis://real-host:6379";

    const { createRedis } = await import("../redis");
    const redis = createRedis();
    expect(redis.constructor.name).toBe("NativeRedisAdapter");
  });

  test("nothing set → throws (loud failure, no silent fallback)", async () => {
    const { createRedis } = await import("../redis");
    expect(() => createRedis()).toThrow("Redis configuration is required");
  });

  test("Upstash creds win over REDIS_URL (documented priority)", async () => {
    process.env.KV_REST_API_URL = "https://example.upstash.io";
    process.env.KV_REST_API_TOKEN = "real-token";
    process.env.REDIS_URL = "redis://should-be-ignored:6379";

    const { createRedis } = await import("../redis");
    const { Redis: UpstashRedis } = await import("@upstash/redis");
    const redis = createRedis();
    expect(redis).toBeInstanceOf(UpstashRedis);
  });
});
