/** Exercises Ethereum and Solana nonce outages through real Hono routes with failing Redis. */
import { expect, mock, test } from "bun:test";

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

const { default: siwe } = await import("./route");
const { default: siws } = await import("../../siws/nonce/route");

test.each([
  ["SIWE", siwe],
  ["SIWS", siws],
] as const)(
  "%s returns retryable503 when nonce persistence fails",
  async (_name, app) => {
    const response = await app.request("/", { method: "GET" }, {});
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Nonce storage unavailable",
      code: "nonce_storage_unavailable",
    });
  },
);
