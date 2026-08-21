/**
 * POST /api/auth/migrate-anonymous contract: the anonymous session is honored
 * only from the HttpOnly cookie (never the request body), and the
 * cookie-authenticated mutation requires the exact-host origin policy plus a
 * non-simple-request marker. Route handler is real; auth, session services,
 * and the migration boundary are mocked.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

let migrationCalls: Array<{ anonUserId: string; stewardId: string }> = [];
let anonSessionForToken: {
  user_id: string;
  converted_at: string | null;
} | null = null;

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUser: async () => ({ id: "user-1", steward_id: "steward-1" }),
}));

mock.module("@/lib/services/anonymous-sessions", () => ({
  anonymousSessionsService: {
    getByToken: async (token: string) =>
      token === "cookie-token" ? anonSessionForToken : null,
  },
}));

mock.module("@/lib/session", () => ({
  migrateAnonymousSession: async (anonUserId: string, stewardId: string) => {
    migrationCalls.push({ anonUserId, stewardId });
    return { mergedData: { conversations: 1 } };
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

const { default: route } = await import("./route");

const ENV = { NODE_ENV: "test" } as never;

function buildApp() {
  const app = new Hono();
  app.route("/api/auth/migrate-anonymous", route);
  return app;
}

function postMigrate(headers: Record<string, string>, body?: string) {
  return buildApp().request(
    "/api/auth/migrate-anonymous",
    { method: "POST", headers, ...(body ? { body } : {}) },
    ENV,
  );
}

beforeEach(() => {
  migrationCalls = [];
  anonSessionForToken = { user_id: "anon-1", converted_at: null };
});

describe("POST /api/auth/migrate-anonymous", () => {
  test("rejects requests with no Origin or Referer", async () => {
    const res = await postMigrate({
      "content-type": "application/json",
      cookie: "eliza-anon-session=cookie-token",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden_origin" });
    expect(migrationCalls).toHaveLength(0);
  });

  test("rejects a simple request without the non-simple marker", async () => {
    const res = await postMigrate({
      origin: "http://localhost:3000",
      "content-type": "text/plain",
      cookie: "eliza-anon-session=cookie-token",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "csrf_marker_required" });
    expect(migrationCalls).toHaveLength(0);
  });

  test("migrates the session identified by the HttpOnly cookie", async () => {
    const res = await postMigrate({
      origin: "http://localhost:3000",
      "content-type": "application/json",
      cookie: "eliza-anon-session=cookie-token",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, migrated: true });
    expect(migrationCalls).toEqual([
      { anonUserId: "anon-1", stewardId: "steward-1" },
    ]);
  });

  test("ignores a session token supplied in the request body", async () => {
    // No cookie: a body-only token must NOT drive a migration.
    const res = await postMigrate(
      {
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      JSON.stringify({ sessionToken: "cookie-token" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ migrated: false });
    expect(migrationCalls).toHaveLength(0);
  });
});
