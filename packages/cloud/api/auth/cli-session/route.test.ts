/**
 * POST /api/auth/cli-session contract: the server mints the session id and a
 * client-supplied id is ignored (id squatting / row-spam hardening), with the
 * minted id returned in the documented response shape.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const createSessionCalls: string[] = [];
const nextSession: {
  session_id: string;
  status: string;
  expires_at: Date;
} = {
  session_id: "bbbbbbbb-2222-4333-8444-cccccccccccc",
  status: "pending",
  expires_at: new Date("2026-05-14T08:00:00.000Z"),
};

mock.module("@/lib/services/cli-auth-sessions", () => ({
  cliAuthSessionsService: {
    createSession: async (sessionId: string) => {
      createSessionCalls.push(sessionId);
      return { ...nextSession, session_id: sessionId };
    },
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

const { default: route } = await import("./route");

const ENV = { NODE_ENV: "test" } as never;

function buildApp() {
  const app = new Hono();
  app.route("/api/auth/cli-session", route);
  return app;
}

beforeEach(() => {
  createSessionCalls.length = 0;
});

describe("POST /api/auth/cli-session", () => {
  test("mints a server-generated UUID session id", async () => {
    const app = buildApp();
    const res = await app.request(
      "/api/auth/cli-session",
      { method: "POST", headers: { "content-type": "application/json" } },
      ENV,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      sessionId: string;
      status: string;
      expiresAt: string;
    };
    expect(body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(body.status).toBe("pending");
    expect(typeof body.expiresAt).toBe("string");
    expect(createSessionCalls).toEqual([body.sessionId]);
  });

  test("ignores a client-supplied sessionId", async () => {
    const app = buildApp();
    const res = await app.request(
      "/api/auth/cli-session",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "attacker-chosen-id" }),
      },
      ENV,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).not.toBe("attacker-chosen-id");
    expect(body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
