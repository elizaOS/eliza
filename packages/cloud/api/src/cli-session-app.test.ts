/**
 * Thin CLI-session shell contract (#22948): the mounted routes behave exactly
 * as they do on the full app — server-minted create, format-gated poll — with
 * the shell's own no-store default, and without serving the authenticated
 * complete mutation.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const createSessionCalls: string[] = [];
const activeSessions = new Map<
  string,
  { session_id: string; status: string; expires_at: Date }
>();

mock.module("@/lib/services/cli-auth-sessions", () => ({
  cliAuthSessionsService: {
    createSession: async (sessionId: string) => {
      createSessionCalls.push(sessionId);
      return {
        session_id: sessionId,
        status: "pending",
        expires_at: new Date("2026-08-20T12:00:00.000Z"),
      };
    },
    getActiveSession: async (sessionId: string) =>
      activeSessions.get(sessionId) ?? null,
    getAndClearApiKey: async () => ({
      status: "unavailable",
      reason: "consumed",
    }),
  },
  looksLikeCliAuthSessionId: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    ),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

const { createCliSessionThinApp } = await import("./cli-session-app");

import type { AppEnv } from "@/types/cloud-worker-env";

const ENV = {
  NODE_ENV: "test",
  ENVIRONMENT: "test",
  REDIS_RATE_LIMITING: "false",
  BLOB: {},
} as unknown as AppEnv["Bindings"];
const PENDING_ID = "bbbbbbbb-2222-4333-8444-cccccccccccc";

beforeEach(() => {
  createSessionCalls.length = 0;
  activeSessions.clear();
});

describe("createCliSessionThinApp", () => {
  test("creates a session with a server-minted UUID, ignoring a client id", async () => {
    const app = createCliSessionThinApp();
    const res = await app.request(
      "/api/auth/cli-session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "attacker-chosen" }),
      },
      ENV,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionId: string; status: string };
    expect(body.status).toBe("pending");
    expect(body.sessionId).not.toBe("attacker-chosen");
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test("polls a pending session by id", async () => {
    activeSessions.set(PENDING_ID, {
      session_id: PENDING_ID,
      status: "pending",
      expires_at: new Date("2026-08-20T12:00:00.000Z"),
    });
    const app = createCliSessionThinApp();
    const res = await app.request(
      `/api/auth/cli-session/${PENDING_ID}`,
      { method: "GET" },
      ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("pending");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("rejects a malformed poll id with 400", async () => {
    const app = createCliSessionThinApp();
    const res = await app.request(
      "/api/auth/cli-session/not-a-uuid",
      { method: "GET" },
      ENV,
    );
    expect(res.status).toBe(400);
  });

  test("polling is not metered by the create's STRICT limiter (12 sequential polls stay 200)", async () => {
    activeSessions.set(PENDING_ID, {
      session_id: PENDING_ID,
      status: "pending",
      expires_at: new Date("2026-08-20T12:00:00.000Z"),
    });
    const app = createCliSessionThinApp();
    for (let i = 0; i < 12; i++) {
      const res = await app.request(
        `/api/auth/cli-session/${PENDING_ID}`,
        { method: "GET" },
        ENV,
      );
      expect(res.status).toBe(200);
    }
  });

  test("rejects a cookie-authenticated cross-origin create (CSRF guard parity with the full app)", async () => {
    const app = createCliSessionThinApp();
    const res = await app.request(
      "https://api.elizacloud.ai/api/auth/cli-session",
      {
        method: "POST",
        headers: {
          cookie: "steward-token-test=ambient",
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: "{}",
      },
      ENV,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("forbidden_origin");
    expect(createSessionCalls).toHaveLength(0);
  });

  test("fails closed in production when REDIS_RATE_LIMITING=true without Redis", async () => {
    const app = createCliSessionThinApp();
    const res = await app.request(
      "/api/auth/cli-session",
      { method: "POST", body: "{}" },
      {
        ...(ENV as object),
        ENVIRONMENT: "production",
        REDIS_RATE_LIMITING: "true",
      } as unknown as AppEnv["Bindings"],
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("RATE_LIMIT_UNAVAILABLE");
    expect(createSessionCalls).toHaveLength(0);
  });

  test("OPTIONS preflight gets first-party CORS for the app origin", async () => {
    const app = createCliSessionThinApp();
    const res = await app.request(
      "https://api.elizacloud.ai/api/auth/cli-session",
      {
        method: "OPTIONS",
        headers: {
          origin: "https://app.elizacloud.ai",
          "access-control-request-method": "POST",
        },
      },
      ENV,
    );
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.elizacloud.ai",
    );
  });

  test("does not serve the authenticated complete mutation", async () => {
    const app = createCliSessionThinApp();
    const res = await app.request(
      `/api/auth/cli-session/${PENDING_ID}/complete`,
      { method: "POST" },
      ENV,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("resource_not_found");
  });
});
