// Exercises cloud API auth create anonymous session route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Count how many anonymous users actually get minted (DB rows inserted).
const createAnonymousUserAndSession = mock(async () => ({
  newUser: { id: "anon-user" },
  newSession: { id: "anon-session" },
}));

mock.module("@/lib/services/anonymous-session-creator", () => ({
  createAnonymousUserAndSession,
}));

// In-memory Redis stand-in so the REAL rateLimit middleware enforces (it falls
// open without a backing store). Implements the subset checkUpstash() uses.
const store = new Map<string, { count: number; expireAt: number }>();
const fakeRedis = {
  async incr(key: string) {
    const entry = store.get(key) ?? {
      count: 0,
      expireAt: Date.now() + 300_000,
    };
    entry.count += 1;
    store.set(key, entry);
    return entry.count;
  },
  async pexpire(key: string, ms: number) {
    const entry = store.get(key);
    if (entry) entry.expireAt = Date.now() + ms;
    return 1;
  },
  async pttl(key: string) {
    const entry = store.get(key);
    return entry ? Math.max(1, entry.expireAt - Date.now()) : -1;
  },
};

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
    store.clear();
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
