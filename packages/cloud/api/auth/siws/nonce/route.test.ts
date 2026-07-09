/**
 * SIWS nonce route coverage mirrors SIWE so Solana sign-in treats Redis write
 * failures as retryable auth dependency outages.
 */

import { describe, expect, mock, test } from "bun:test";

const setex = mock(async () => {
  throw new Error("redis unavailable");
});

mock.module("@/lib/cache/redis-factory", () => ({
  buildRedisClient: () => ({ setex }),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { warn: mock(() => undefined) },
}));

const { default: app } = await import("./route");

describe("GET /api/auth/siws/nonce", () => {
  test("returns retryable 503 when nonce persistence fails", async () => {
    const res = await app.request("/", { method: "GET" }, {});

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({
      error: "Nonce storage unavailable",
      code: "nonce_storage_unavailable",
    });
  });
});
