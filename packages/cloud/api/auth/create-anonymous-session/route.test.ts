// Exercises cloud API auth create anonymous session route.test behavior with deterministic Worker route fixtures.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRedisFactory from "@/lib/cache/redis-factory";

const realRedisFactoryExports = { ...realRedisFactory };

// Count how many anonymous users actually get minted (DB rows inserted).
const createAnonymousUserAndSession = mock(async () => ({
  newUser: { id: "anon-user" },
  newSession: { id: "anon-session" },
}));

mock.module("@/lib/services/anonymous-session-creator", () => ({
  createAnonymousUserAndSession,
}));

// In-memory Redis stand-in so the REAL rateLimit middleware enforces (it falls
// open without a backing store). checkRateLimitRedis drives a sliding-window
// sorted set through client.pipeline(), so the stand-in must be MockSocketRedis
// (matches the CompatibleRedis pipeline surface) rather than a token-bucket shim.
const { MockSocketRedis } = await import("@/lib/cache/mock-redis");
const fakeRedis = new MockSocketRedis();

mock.module("@/lib/cache/redis-factory", () => ({
  buildRedisClient: () => fakeRedis,
}));

const { default: app } = await import("./route");

const ENV = { REDIS_RATE_LIMITING: "true", NODE_ENV: "development" };

function mint(ip: string) {
  return app.fetch(
    new Request("https://api.example.test/?returnUrl=/chat", {
      headers: { "cf-connecting-ip": ip },
    }),
    ENV,
  );
}

describe("create-anonymous-session anti-sybil rate limit", () => {
  beforeEach(() => {
    createAnonymousUserAndSession.mockClear();
  });

  afterAll(() => {
    mock.module("@/lib/cache/redis-factory", () => realRedisFactoryExports);
  });

  test("caps anonymous mints per IP and stops creating users after the cap", async () => {
    const ip = "203.0.113.7";
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await mint(ip)).status);
    }

    // CRITICAL preset = 5 per window: first 5 redirect (302), rest are 429.
    expect(statuses.filter((s) => s === 302)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);

    // The throttled requests never reached the handler, so no extra rows.
    expect(createAnonymousUserAndSession).toHaveBeenCalledTimes(5);
  });

  test("a different IP gets its own fresh budget", async () => {
    for (let i = 0; i < 6; i++) await mint("203.0.113.7");
    expect((await mint("198.51.100.9")).status).toBe(302);
  });
});
