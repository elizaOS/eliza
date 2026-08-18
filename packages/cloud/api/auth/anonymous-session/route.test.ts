/**
 * Drives the real anonymous-session mint route with deterministic service and
 * rate-limit boundaries to verify spend-gate configuration reaches storage.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";

let lastMintParams: { messagesLimit: number; expiresAt: Date } | null = null;

mock.module("@/lib/services/anonymous-session-creator", () => ({
  createAnonymousUserAndSession: async (params: {
    messagesLimit: number;
    expiresAt: Date;
  }) => {
    lastMintParams = params;
    return {
      newUser: { id: "anon-user-test" },
      newSession: {
        id: "sess-test",
        message_count: 0,
        messages_limit: params.messagesLimit,
        is_active: true,
      },
    };
  },
}));

// The mint path never touches the DB or user/session lookups (those are only
// reached with a valid cookie). Stub them so importing the route does not pull
// in plugin-sql / the unbuilt @elizaos/core.
mock.module("@/db/helpers", () => ({
  dbRead: { query: { userIdentities: { findFirst: async () => null } } },
}));
mock.module("@/db/schemas/user-identities", () => ({ userIdentities: {} }));
mock.module("@/lib/services/users", () => ({
  usersService: { getById: async () => null },
}));
mock.module("@/lib/services/anonymous-sessions", () => ({
  anonymousSessionsService: { getByToken: async () => null },
}));

// Rate-limit middleware falls open in tests (no Redis binding); make it a no-op
// so the mint path is reached deterministically. getRequestIp is the real
// helper's edge-IP resolver; pin it to a fixed address.
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<unknown>) =>
    await next(),
  getIpKey: () => "test-ip",
  getRequestIp: () => "192.0.2.55",
  RateLimitPresets: {
    AGGRESSIVE: { windowMs: 60_000, maxRequests: 30 },
    CRITICAL: { windowMs: 300_000, maxRequests: 5 },
  },
}));

const { default: app } = await import("./route");

const EXEC_CTX = {
  waitUntil: (_p: Promise<unknown>) => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

async function post(env: Record<string, unknown>) {
  lastMintParams = null;
  // No cookie → the handler always mints a fresh session.
  return app.request("/", { method: "POST" }, env, EXEC_CTX);
}

function expiryDaysOf(params: { expiresAt: Date }): number {
  return Math.round(
    (params.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
  );
}

describe("#19716 auth/anonymous-session — spend-gate env validation", () => {
  beforeEach(() => {
    lastMintParams = null;
  });

  test("unset PUBLIC_CHAT_MESSAGE_LIMIT keeps default 3 silently", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { session: { messages_limit: number } };
    expect(json.session.messages_limit).toBe(3);
    expect(lastMintParams).not.toBeNull();
    expect(lastMintParams!.messagesLimit).toBe(3);
  });

  test("valid PUBLIC_CHAT_MESSAGE_LIMIT=25 is honored", async () => {
    const res = await post({ PUBLIC_CHAT_MESSAGE_LIMIT: "25" });
    expect(res.status).toBe(200);
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
    "malformed PUBLIC_CHAT_MESSAGE_LIMIT=%p (%s) falls back to default 3",
    async (value) => {
      await post({ PUBLIC_CHAT_MESSAGE_LIMIT: value });
      expect(lastMintParams!.messagesLimit).toBe(3);
    },
  );

  test("overflow PUBLIC_CHAT_MESSAGE_LIMIT (400 nines) falls back to default 3", async () => {
    await post({ PUBLIC_CHAT_MESSAGE_LIMIT: "9".repeat(400) });
    expect(lastMintParams!.messagesLimit).toBe(3);
  });

  test("above-cap PUBLIC_CHAT_MESSAGE_LIMIT=1001 falls back to default 3", async () => {
    await post({ PUBLIC_CHAT_MESSAGE_LIMIT: "1001" });
    expect(lastMintParams!.messagesLimit).toBe(3);
  });

  test("malformed ANON_SESSION_EXPIRY_DAYS=7.0 falls back to default 7 days", async () => {
    await post({ ANON_SESSION_EXPIRY_DAYS: "7.0" });
    expect(expiryDaysOf(lastMintParams!)).toBe(7);
  });

  test("valid ANON_SESSION_EXPIRY_DAYS=30 is honored", async () => {
    await post({ ANON_SESSION_EXPIRY_DAYS: "30" });
    expect(expiryDaysOf(lastMintParams!)).toBe(30);
  });

  test("above-cap ANON_SESSION_EXPIRY_DAYS=366 falls back to default 7 days", async () => {
    await post({ ANON_SESSION_EXPIRY_DAYS: "366" });
    expect(expiryDaysOf(lastMintParams!)).toBe(7);
  });
});
