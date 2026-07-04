/**
 * Rate limiter fail-closed behavior on a runtime Redis error (#12227 M11).
 *
 * The limiter falls OPEN on a Redis error at request time — correct for
 * ordinary routes (a store outage shouldn't 500 the app). But money/auth
 * routes (steward-session mint, crypto top-up) must fail CLOSED: losing the
 * limiter there is worse than a brief 503. `RateLimitConfig.failClosed` opts a
 * route into rejecting (503) instead of serving unlimited when Redis throws.
 *
 * The Redis DEPENDENCY is mocked to simulate the outage (that outage is the
 * condition under test); the real `rateLimit` middleware logic runs.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

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
};

mock.module("../cache/redis-factory", () => ({
  buildRedisClient: () => throwingRedis,
  hasRedisConfig: () => true,
  isCloudflareWorkerRuntime: () => false,
}));

const { rateLimit, RateLimitPresets, getIpKey } = await import("./rate-limit-hono-cloudflare");

// A configured, non-disabled env so getRedis returns the (throwing) client.
const ENV = { REDIS_URL: "redis://mock:6379", NODE_ENV: "production" };

function appWith(config: Parameters<typeof rateLimit>[0]) {
  const app = new Hono();
  app.use(rateLimit(config));
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
  mock.restore();
});

describe("rateLimit — fail-closed vs fall-open on runtime Redis error (M11)", () => {
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
});
