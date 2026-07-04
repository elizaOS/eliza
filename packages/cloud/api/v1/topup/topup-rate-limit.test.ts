/**
 * Top-up money routes are rate-limited and fail CLOSED on a Redis outage
 * (#12227 M11). Proves the `rateLimit({ failClosed: true })` middleware is
 * actually mounted on `/v1/topup/10` by driving a request through the real
 * route with a throwing Redis dependency: the request must be rejected (503)
 * BEFORE the top-up handler runs.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const handler = mock(async () => Response.json({ credited: true }));

mock.module("@/lib/services/topup-handler", () => ({
  createTopupHandler: () => handler,
}));

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

const { default: topupRoute } = await import("./10/route");

const ENV = { REDIS_URL: "redis://mock:6379", NODE_ENV: "production" };

function post() {
  const app = new Hono();
  app.route("/api/v1/topup/10", topupRoute);
  return app.fetch(
    new Request("https://api.example.test/api/v1/topup/10", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.9" },
    }),
    ENV,
  );
}

describe("v1/topup/10 — money route fails closed on Redis outage (M11)", () => {
  beforeEach(() => handler.mockClear());

  test("a Redis outage returns 503 and never reaches the top-up handler", async () => {
    const res = await post();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: "rate_limit_unavailable",
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
