/**
 * Steward session minting must keep login available when the rate-limit Redis
 * backing store is down. The limiter still runs and reports the degraded policy,
 * but the request reaches the normal auth validation path instead of returning
 * `rate_limit_unavailable` before the browser can mint a session cookie.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";

const throwingRedis = {
  incr: async () => {
    throw new Error("ECONNREFUSED: redis down");
  },
  pttl: async () => 1,
  pexpire: async () => 1,
};

mock.module("@/lib/cache/redis-factory", () => ({
  buildRedisClient: () => throwingRedis,
  hasRedisConfig: () => true,
  isCloudflareWorkerRuntime: () => false,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

const ENV = {
  ENVIRONMENT: "staging",
  NODE_ENV: "production",
  REDIS_URL: "redis://mock:6379",
};

afterAll(() => {
  mock.restore();
});

describe("POST /api/auth/steward-session rate limiting", () => {
  test("falls open on Redis outage and reaches normal auth validation", async () => {
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.19",
          host: "api-staging.elizacloud.ai",
          origin: "https://staging.elizacloud.ai",
        },
        body: "{}",
      },
      ENV,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: "missing_token",
    });
    expect(res.headers.get("X-RateLimit-Policy")).toBe("redis-unavailable");
  });
});
