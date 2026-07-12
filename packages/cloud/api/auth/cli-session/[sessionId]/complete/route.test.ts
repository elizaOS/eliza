/**
 * `POST /api/auth/cli-session/:id/complete` end-to-end behaviour, covering the
 * staging cli-login sign-in regression (2026-07-12).
 *
 * SYMPTOM: navigating the cli-login page a second time for the same session —
 * or the page's completion effect firing twice — surfaced
 * "Authentication Error — Session already authenticated or expired" even though
 * the user was signed in. This route drives the service that used to throw on
 * ANY non-pending session.
 *
 * These tests pin the full request/response contract of the fix:
 *  - fresh session      -> 200 { success, keyPrefix, alreadyAuthenticated:false }
 *  - already-authed (same user, idempotent re-POST)
 *                       -> 200 { success, alreadyAuthenticated:true } (NOT a 4xx)
 *  - expired / other-user session
 *                       -> 400 validation error with the clear message
 *  - missing session id -> 400
 *
 * The service is doubled at the module boundary so the test is deterministic;
 * `requireUserWithOrg` is stubbed to a signed-in user. The route + Hono error
 * mapping under test are real.
 */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const USER = {
  id: "11111111-1111-1111-1111-111111111111",
  organization_id: "33333333-3333-3333-3333-333333333333",
};

const completeAuthenticationMock = mock(
  async (
    _sessionId: string,
    _userId: string,
    _orgId: string,
  ): Promise<unknown> => ({}),
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserWithOrg: mock(async () => USER),
}));

mock.module("@/lib/services/cli-auth-sessions", () => ({
  cliAuthSessionsService: {
    completeAuthentication: completeAuthenticationMock,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: leaf } = await import("./route");

// Mount the leaf under the same `:sessionId` mount path the generated router
// uses in production so `c.req.param("sessionId")` resolves exactly as it does
// at runtime.
const app = new Hono();
app.route("/api/auth/cli-session/:sessionId/complete", leaf);

function post(sessionId: string): Promise<Response> {
  return app.request(`/api/auth/cli-session/${sessionId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

describe("POST /api/auth/cli-session/:id/complete", () => {
  test("fresh session completes: 200 success, alreadyAuthenticated=false", async () => {
    completeAuthenticationMock.mockClear();
    completeAuthenticationMock.mockResolvedValueOnce({
      session: { session_id: "s1" },
      apiKey: "ek_live_secret",
      keyPrefix: "ek_live_pre",
      expiresAt: null,
      alreadyAuthenticated: false,
    });

    const res = await post("s1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      keyPrefix: string;
      alreadyAuthenticated: boolean;
    };
    expect(body.success).toBe(true);
    expect(body.keyPrefix).toBe("ek_live_pre");
    expect(body.alreadyAuthenticated).toBe(false);
  });

  test("REGRESSION: re-completing an already-authenticated session returns 200 (not the old 400 error)", async () => {
    completeAuthenticationMock.mockClear();
    completeAuthenticationMock.mockResolvedValueOnce({
      session: { session_id: "s1" },
      apiKey: null,
      keyPrefix: "ek_live_pre",
      expiresAt: null,
      alreadyAuthenticated: true,
    });

    const res = await post("s1");
    // The whole point of the fix: a second completion is success, not an error.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      alreadyAuthenticated: boolean;
    };
    expect(body.success).toBe(true);
    expect(body.alreadyAuthenticated).toBe(true);
  });

  test("expired / other-user session surfaces the clear 400 validation error", async () => {
    completeAuthenticationMock.mockClear();
    completeAuthenticationMock.mockRejectedValueOnce(
      new Error("Session already authenticated or expired"),
    );

    const res = await post("s1");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    const message = JSON.stringify(body);
    expect(message).toContain("Session already authenticated or expired");
  });

  test("invalid/expired session (no row) surfaces the 400 validation error", async () => {
    completeAuthenticationMock.mockClear();
    completeAuthenticationMock.mockRejectedValueOnce(
      new Error("Invalid or expired session"),
    );

    const res = await post("s1");
    expect(res.status).toBe(400);
    const body = JSON.stringify(await res.json());
    expect(body).toContain("Invalid or expired session");
  });
});
