/**
 * SIWS (Solana) nonce route integration coverage: a THROWING Redis must return
 * the same retryable 503 as a missing client — never `500 internal_error`
 * (staging outage class: CLOUD_ONBOARDING_PROVISIONING_REVIEW.md §8c). Unlike
 * the colocated unit test (route.test.ts, which stubs the rate limiter), this
 * drives the REAL rate-limit middleware alongside the route and also proves
 * the healthy path issues + persists a bound nonce; only the Redis factory is
 * swapped.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

type RedisMode = "throwing" | "null" | "healthy";
let redisMode: RedisMode = "healthy";

const stored = new Map<string, string>();

const throwingRedis = new Proxy(
  {},
  {
    get:
      () =>
      async (..._args: unknown[]) => {
        throw new Error("ECONNREFUSED: redis down");
      },
  },
);

const healthyRedis = {
  incr: async () => 1,
  pttl: async () => 60_000,
  pexpire: async () => 1,
  expire: async () => 1,
  setex: async (key: string, _ttl: number, value: string) => {
    stored.set(key, value);
    return "OK";
  },
  get: async (key: string) => stored.get(key) ?? null,
  del: async (key: string) => (stored.delete(key) ? 1 : 0),
};

mock.module("@/lib/cache/redis-factory", () => ({
  buildRedisClient: () => {
    if (redisMode === "null") return null;
    return redisMode === "throwing" ? throwingRedis : healthyRedis;
  },
  hasRedisConfig: () => redisMode !== "null",
  isCloudflareWorkerRuntime: () => false,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: nonceRoute } = await import("./route");
const { _resetRedisUnavailableFallbackBuckets } = await import(
  "@/lib/middleware/rate-limit-hono-cloudflare"
);

const ENV = {
  ENVIRONMENT: "staging",
  NODE_ENV: "production",
  REDIS_URL: "redis://mock:6379",
  NEXT_PUBLIC_APP_URL: "https://staging.elizacloud.ai",
};

function getNonce(query = "") {
  const app = new Hono();
  app.route("/api/auth/siws/nonce", nonceRoute);
  return app.fetch(
    new Request(
      `https://api-staging.elizacloud.ai/api/auth/siws/nonce${query}`,
      {
        headers: { "cf-connecting-ip": "203.0.113.21" },
      },
    ),
    ENV,
  );
}

beforeEach(() => {
  redisMode = "healthy";
  stored.clear();
  _resetRedisUnavailableFallbackBuckets();
});

describe("GET /api/auth/siws/nonce — Redis failure boundary", () => {
  test("throwing Redis returns a retryable 503, not 500 — with the real rate limiter in front", async () => {
    redisMode = "throwing";
    const res = await getNonce();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    await expect(res.json()).resolves.toMatchObject({
      error: "Nonce storage unavailable",
      code: "nonce_storage_unavailable",
    });
  });

  test("missing Redis client returns the same 503 outage signal", async () => {
    redisMode = "null";
    const res = await getNonce();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: "Nonce storage unavailable",
    });
  });

  test("healthy Redis issues a nonce (200) with the SIWS parameters", async () => {
    const res = await getNonce();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as {
      nonce: string;
      domain: string;
      uri: string;
      chainId: string;
      version: string;
    };
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(body.domain).toBe("staging.elizacloud.ai");
    expect(body.chainId).toBe("solana:mainnet");
    expect(body.version).toBe("1");
    // The nonce was actually persisted with its issued binding.
    expect(stored.size).toBe(1);
    const [storedValue] = stored.values();
    expect(JSON.parse(storedValue)).toMatchObject({
      uri: "https://staging.elizacloud.ai",
      chainId: "solana:mainnet",
    });
  });
});
