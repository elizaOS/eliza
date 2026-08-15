/** Exercises anonymous-session creation through deterministic Worker fixtures. */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRedisFactory from "@/lib/cache/redis-factory";

const realRedisFactoryExports = { ...realRedisFactory };

// Count how many anonymous users actually get minted (DB rows inserted) and
// capture the spend-gate params so env-var validation can be asserted.
let lastMintParams: { messagesLimit: number; expiresAt: Date } | null = null;
const createAnonymousUserAndSession = mock(
  async (params: { messagesLimit: number; expiresAt: Date }) => {
    lastMintParams = params;
    return {
      newUser: { id: "anon-user" },
      newSession: { id: "anon-session" },
    };
  },
);

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

// #19716 — the spend-gate env vars must be parsed with a strict canonical
// grammar, not tolerant `Number.parseInt`. A silently mutated `messages_limit`
// (the per-guest anonymous spend gate) has direct billing impact on the
// application owner. Each case uses a unique source IP so the anti-sybil rate
// limit (5 mints / IP) never trips within a single-request test.
describe("#19716 create-anonymous-session — spend-gate env validation", () => {
  let ipCounter = 0;

  async function mintWith(env: Record<string, unknown>) {
    lastMintParams = null;
    ipCounter += 1;
    const res = await app.fetch(
      new Request("https://api.example.test/?returnUrl=/chat", {
        headers: { "cf-connecting-ip": `198.51.100.${ipCounter}` },
      }),
      { ...ENV, ...env },
    );
    return res;
  }

  function expiryDaysOf(params: { expiresAt: Date }): number {
    return Math.round(
      (params.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
    );
  }

  test("unset ANON_MESSAGE_LIMIT keeps default 5 silently", async () => {
    const res = await mintWith({});
    expect(res.status).toBe(302);
    expect(lastMintParams).not.toBeNull();
    expect(lastMintParams!.messagesLimit).toBe(5);
  });

  test("valid ANON_MESSAGE_LIMIT=25 is honored", async () => {
    await mintWith({ ANON_MESSAGE_LIMIT: "25" });
    expect(lastMintParams!.messagesLimit).toBe(25);
  });

  test.each([
    ["5oops", "trailing junk"],
    ["1e2", "exponent notation"],
    ["7.0", "decimal"],
    ["05", "leading zero"],
    ["abc", "non-numeric"],
    ["0", "zero"],
    ["-3", "negative"],
    ["  ", "whitespace-only"],
  ])(
    "malformed ANON_MESSAGE_LIMIT=%p (%s) falls back to default 5",
    async (value) => {
      await mintWith({ ANON_MESSAGE_LIMIT: value });
      expect(lastMintParams!.messagesLimit).toBe(5);
    },
  );

  test("overflow ANON_MESSAGE_LIMIT (400 nines) falls back to default 5", async () => {
    await mintWith({ ANON_MESSAGE_LIMIT: "9".repeat(400) });
    expect(lastMintParams!.messagesLimit).toBe(5);
  });

  test("above-cap ANON_MESSAGE_LIMIT=1001 falls back to default 5", async () => {
    await mintWith({ ANON_MESSAGE_LIMIT: "1001" });
    expect(lastMintParams!.messagesLimit).toBe(5);
  });

  test("malformed ANON_SESSION_EXPIRY_DAYS=7.0 falls back to default 7 days", async () => {
    await mintWith({ ANON_SESSION_EXPIRY_DAYS: "7.0" });
    expect(expiryDaysOf(lastMintParams!)).toBe(7);
  });

  test("valid ANON_SESSION_EXPIRY_DAYS=30 is honored", async () => {
    await mintWith({ ANON_SESSION_EXPIRY_DAYS: "30" });
    expect(expiryDaysOf(lastMintParams!)).toBe(30);
  });
});
