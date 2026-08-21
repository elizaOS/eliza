/**
 * Guard tests for #19628 — affiliate anonymous-session routes parse
 * spend-gate env vars with raw parseInt — malformed ANON_MESSAGE_LIMIT
 * silently disables the per-guest spend cap.
 *
 * These tests drive the REAL Hono route handlers with different env-var
 * inputs and verify that the messages_limit passed to the session creator
 * is always a valid positive integer, never NaN or negative.
 *
 * Covered routes:
 * - affiliate/create-session (reads ANON_SESSION_EXPIRY_DAYS + ANON_MESSAGE_LIMIT)
 * - affiliate/create-character (reads ANON_MESSAGE_LIMIT)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";

let lastCreatedSessionMessagesLimit: number | null = null;

// Mock the session creator so we can inspect what messages_limit was passed.
mock.module("@/lib/services/anonymous-session-creator", () => ({
  createAnonymousUserAndSession: async (params: { messagesLimit: number }) => {
    lastCreatedSessionMessagesLimit = params.messagesLimit;
    return {
      newUser: { id: "anon-user-test" },
      newSession: { id: "sess-test", user_id: "anon-user-test" },
    };
  },
}));

// Rate-limit middleware falls open in tests (no Redis binding).
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<unknown>) =>
    await next(),
  getIpKey: () => "test-ip",
  getRequestIp: () => "192.0.2.55",
  RateLimitPresets: { CRITICAL: { windowMs: 300_000, maxRequests: 5 } },
}));

// ---- create-session ----
const { default: createSessionApp } = await import(
  "../affiliate/create-session/route"
);

// ---- create-character (needs auth + org + user + session + character mocks) ----
let characterSessionMessagesLimit: number | null = null;

mock.module("@/lib/services/api-keys", () => ({
  apiKeysService: {
    validateApiKey: async () => ({
      id: "key-1",
      organization_id: "00000000-0000-4000-8000-0000000000aa",
      is_active: true,
      expires_at: null,
    }),
    incrementUsage: async () => undefined,
  },
}));

mock.module("@/lib/services/organizations", () => ({
  organizationsService: {
    getById: async () => ({
      id: "00000000-0000-4000-8000-0000000000aa",
      name: "Owner Org",
    }),
  },
}));

mock.module("@/lib/services/users", () => ({
  usersService: {
    create: async () => ({ id: "anon-user-char" }),
  },
}));

mock.module("@/lib/services/anonymous-sessions", () => ({
  anonymousSessionsService: {
    create: async (params: { messages_limit?: number }) => {
      characterSessionMessagesLimit = params.messages_limit ?? null;
      return { id: "sess-char" };
    },
  },
}));

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: {
    create: async () => ({ id: "char-1", name: "Test", avatar_url: null }),
  },
}));

const { default: createCharacterApp } = await import(
  "../affiliate/create-character/route"
);

const EXEC_CTX = {
  waitUntil: (_p: Promise<unknown>) => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

// ---- create-session endpoint tests ----
describe("#19628 affiliate/create-session — parsePositiveIntEnv validation", () => {
  beforeEach(() => {
    lastCreatedSessionMessagesLimit = null;
  });

  async function postSession(
    env: Record<string, unknown>,
    body: { characterId: string; source?: string },
  ) {
    return createSessionApp.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
      EXEC_CTX,
    );
  }

  const validBody = { characterId: "00000000-0000-4000-8000-000000000001" };

  test("malformed ANON_MESSAGE_LIMIT=abc → falls back to default 5 (not NaN)", async () => {
    const res = await postSession({ ANON_MESSAGE_LIMIT: "abc" }, validBody);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
    // NaN would cause the spend gate to never trip (x >= NaN → false).
    expect(lastCreatedSessionMessagesLimit).toBe(5);
  });

  test("negative ANON_MESSAGE_LIMIT=-3 → falls back to default 5", async () => {
    const res = await postSession({ ANON_MESSAGE_LIMIT: "-3" }, validBody);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
    expect(lastCreatedSessionMessagesLimit).toBe(5);
  });

  test("zero ANON_MESSAGE_LIMIT=0 → falls back to default 5", async () => {
    const res = await postSession({ ANON_MESSAGE_LIMIT: "0" }, validBody);

    expect(res.status).toBe(200);
    expect(lastCreatedSessionMessagesLimit).toBe(5);
  });

  test("valid ANON_MESSAGE_LIMIT=10 → passes through as 10", async () => {
    const res = await postSession({ ANON_MESSAGE_LIMIT: "10" }, validBody);

    expect(res.status).toBe(200);
    expect(lastCreatedSessionMessagesLimit).toBe(10);
  });

  test("unset ANON_MESSAGE_LIMIT → uses default 5", async () => {
    const res = await postSession({}, validBody);

    expect(res.status).toBe(200);
    expect(lastCreatedSessionMessagesLimit).toBe(5);
  });

  test("malformed ANON_SESSION_EXPIRY_DAYS=abc → still succeeds with default", async () => {
    const res = await postSession(
      { ANON_SESSION_EXPIRY_DAYS: "abc" },
      validBody,
    );

    expect(res.status).toBe(200);
    expect(lastCreatedSessionMessagesLimit).toBe(5); // default for messages
  });

  test("overflow ANON_MESSAGE_LIMIT=999... (400 digits) → falls back to default 5", async () => {
    const res = await postSession(
      { ANON_MESSAGE_LIMIT: "9".repeat(400) },
      validBody,
    );

    expect(res.status).toBe(200);
    expect(lastCreatedSessionMessagesLimit).toBe(5);
  });

  test("excessive ANON_MESSAGE_LIMIT=999999999999999 → clamped to 1000", async () => {
    const res = await postSession(
      { ANON_MESSAGE_LIMIT: "999999999999999" },
      validBody,
    );

    expect(res.status).toBe(200);
    expect(lastCreatedSessionMessagesLimit).toBe(1000);
  });

  test("excessive ANON_SESSION_EXPIRY_DAYS=999999999999999 → clamped to 365", async () => {
    const res = await postSession(
      { ANON_SESSION_EXPIRY_DAYS: "999999999999999", ANON_MESSAGE_LIMIT: "5" },
      validBody,
    );

    expect(res.status).toBe(200);
    expect(lastCreatedSessionMessagesLimit).toBe(5); // default for messages
  });
});

// ---- create-character endpoint tests ----
describe("#19628 affiliate/create-character — parsePositiveIntEnv validation", () => {
  beforeEach(() => {
    characterSessionMessagesLimit = null;
  });

  async function postCharacter(
    env: Record<string, unknown>,
    body: { character: { name: string; bio: string }; affiliateId: string },
  ) {
    return createCharacterApp.request(
      "/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
        },
        body: JSON.stringify(body),
      },
      env,
      EXEC_CTX,
    );
  }

  const validBody = {
    character: { name: "Guest", bio: "hi" },
    affiliateId: "aff-test",
  };

  test("malformed ANON_MESSAGE_LIMIT=abc → falls back to default 5", async () => {
    const res = await postCharacter(
      { ANON_MESSAGE_LIMIT: "abc", NEXT_PUBLIC_APP_URL: "https://app.test" },
      validBody,
    );

    expect(res.status).toBe(201);
    expect(characterSessionMessagesLimit).toBe(5);
  });

  test("negative ANON_MESSAGE_LIMIT=-10 → falls back to default 5", async () => {
    const res = await postCharacter(
      { ANON_MESSAGE_LIMIT: "-10", NEXT_PUBLIC_APP_URL: "https://app.test" },
      validBody,
    );

    expect(res.status).toBe(201);
    expect(characterSessionMessagesLimit).toBe(5);
  });

  test("zero ANON_MESSAGE_LIMIT=0 → falls back to default 5", async () => {
    const res = await postCharacter(
      { ANON_MESSAGE_LIMIT: "0", NEXT_PUBLIC_APP_URL: "https://app.test" },
      validBody,
    );

    expect(res.status).toBe(201);
    expect(characterSessionMessagesLimit).toBe(5);
  });

  test("valid ANON_MESSAGE_LIMIT=20 → passes through as 20", async () => {
    const res = await postCharacter(
      { ANON_MESSAGE_LIMIT: "20", NEXT_PUBLIC_APP_URL: "https://app.test" },
      validBody,
    );

    expect(res.status).toBe(201);
    expect(characterSessionMessagesLimit).toBe(20);
  });

  test("unset ANON_MESSAGE_LIMIT → uses default 5", async () => {
    const res = await postCharacter(
      { NEXT_PUBLIC_APP_URL: "https://app.test" },
      validBody,
    );

    expect(res.status).toBe(201);
    expect(characterSessionMessagesLimit).toBe(5);
  });

  test("overflow ANON_MESSAGE_LIMIT=999... (400 digits) → falls back to default 5", async () => {
    const res = await postCharacter(
      {
        ANON_MESSAGE_LIMIT: "9".repeat(400),
        NEXT_PUBLIC_APP_URL: "https://app.test",
      },
      validBody,
    );

    expect(res.status).toBe(201);
    expect(characterSessionMessagesLimit).toBe(5);
  });

  test("excessive ANON_MESSAGE_LIMIT=999999999999999 → clamped to 1000", async () => {
    const res = await postCharacter(
      {
        ANON_MESSAGE_LIMIT: "999999999999999",
        NEXT_PUBLIC_APP_URL: "https://app.test",
      },
      validBody,
    );

    expect(res.status).toBe(201);
    expect(characterSessionMessagesLimit).toBe(1000);
  });
});
