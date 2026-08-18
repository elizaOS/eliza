/**
 * Security contract for W5-011: the anonymous-session mint routes persist the
 * request IP into `anonymous_sessions.ip_address`, the abuse-investigation
 * audit trail. They must persist the edge-verified IP (cf-connecting-ip, via
 * getRequestIp) — never a client-spoofed x-real-ip / x-forwarded-for value.
 * These tests drive the REAL Hono routes and the REAL getRequestIp; only the
 * session-creator boundary (which receives the IP) is stubbed.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";

let capturedIpAddress: string | undefined;
const createAnonymousUserAndSession = mock(
  async (input: {
    sessionToken: string;
    expiresAt: Date;
    ipAddress?: string;
    userAgent?: string;
    messagesLimit: number;
  }) => {
    capturedIpAddress = input.ipAddress;
    return {
      newUser: { id: "anon-user-1", is_anonymous: true },
      newSession: {
        id: "anon-session-1",
        user_id: "anon-user-1",
        message_count: 0,
        messages_limit: input.messagesLimit,
        expires_at: input.expiresAt,
        is_active: true,
      },
    };
  },
);

mock.module("@/lib/services/anonymous-session-creator", () => ({
  createAnonymousUserAndSession,
}));
mock.module("@/lib/services/anonymous-sessions", () => ({
  anonymousSessionsService: { getByToken: mock(async () => null) },
}));
mock.module("@/lib/services/users", () => ({
  usersService: { getById: mock(async () => null) },
}));
mock.module("@/db/helpers", () => ({
  dbRead: {
    query: { userIdentities: { findFirst: mock(async () => undefined) } },
  },
}));
mock.module("@/db/schemas/user-identities", () => ({
  userIdentities: { user_id: "user_id" },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

// Import AFTER the mocks are registered so the routes bind the stubs.
const { default: anonymousSessionApp } = await import(
  "../auth/anonymous-session/route"
);
const { default: affiliateCreateSessionApp } = await import(
  "../affiliate/create-session/route"
);

const ENV = { NODE_ENV: "test" } as unknown as Record<string, unknown>;

// cf-connecting-ip is set by the Cloudflare edge and cannot be spoofed by the
// client; the x-real-ip / x-forwarded-for values below are attacker-controlled.
const EDGE_IP = "192.0.2.55";
const SPOOFED_HEADERS = {
  "cf-connecting-ip": EDGE_IP,
  "x-real-ip": "203.0.113.9",
  "x-forwarded-for": "198.51.100.7, 10.0.0.1",
};

describe("anonymous mint routes — persisted IP is the edge-verified one (W5-011)", () => {
  beforeEach(() => {
    capturedIpAddress = undefined;
    createAnonymousUserAndSession.mockClear();
  });

  test("auth/anonymous-session ignores spoofed x-real-ip / x-forwarded-for", async () => {
    const res = await anonymousSessionApp.request(
      "https://api.eliza.app/",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...SPOOFED_HEADERS },
        body: "{}",
      },
      ENV,
    );

    expect(res.status).toBe(200);
    expect(createAnonymousUserAndSession).toHaveBeenCalledTimes(1);
    expect(capturedIpAddress).toBe(EDGE_IP);
  });

  test("affiliate/create-session ignores spoofed x-real-ip / x-forwarded-for", async () => {
    const res = await affiliateCreateSessionApp.request(
      "https://api.eliza.app/",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...SPOOFED_HEADERS },
        body: JSON.stringify({
          characterId: "00000000-0000-4000-8000-0000000000aa",
        }),
      },
      ENV,
    );

    expect(res.status).toBe(200);
    expect(createAnonymousUserAndSession).toHaveBeenCalledTimes(1);
    expect(capturedIpAddress).toBe(EDGE_IP);
  });
});
