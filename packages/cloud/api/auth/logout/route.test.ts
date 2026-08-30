/**
 * Logout enforces the Steward mutation origin policy while keeping production
 * and staging cookie names isolated. The harness mocks teardown collaborators
 * but exercises the real route and cookie headers.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const getCurrentUserMock = mock(
  async (): Promise<{ id: string; organization_id: string } | null> => null,
);
const readStewardSessionTokenMock = mock((): string | null => null);
const endAllUserSessionsMock = mock(async () => undefined);
const verifyStewardTokenMock = mock(async () => ({
  userId: "steward-1",
  issuedAt: 100,
}));
const revokeInferenceSessionsThroughMock = mock(async () => undefined);
const markSsoBridgeLogoutMock = mock(async () => undefined);

mock.module("@/lib/auth", () => ({
  invalidateSessionCaches: mock(async () => undefined),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser: getCurrentUserMock,
  readStewardSessionToken: readStewardSessionTokenMock,
}));
mock.module("@/lib/auth/steward-client", () => ({
  verifyStewardTokenCached: verifyStewardTokenMock,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  getRequestIp: () => undefined,
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/services/user-sessions", () => ({
  userSessionsService: {
    endAllUserSessions: endAllUserSessionsMock,
  },
}));
mock.module("@/lib/services/inference-credential-revocation", () => ({
  isInferenceStrongRevocationEnabled: (env: Record<string, unknown>) =>
    env.INFERENCE_STRONG_REVOCATION_ENABLED === "true",
  revokeInferenceSessionsThrough: revokeInferenceSessionsThroughMock,
}));
mock.module("@/lib/services/sso-bridge-codes", () => ({
  markSsoBridgeLogout: markSsoBridgeLogoutMock,
}));

mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({
    emit: mock(async () => undefined),
  }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

function deletedCookieNames(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((cookie) => /Max-Age=0/i.test(cookie))
    .map((cookie) => cookie.split("=")[0]);
}

beforeEach(() => {
  getCurrentUserMock.mockResolvedValue(null);
  readStewardSessionTokenMock.mockReturnValue(null);
  verifyStewardTokenMock.mockResolvedValue({
    userId: "steward-1",
    issuedAt: 100,
  });
  revokeInferenceSessionsThroughMock.mockResolvedValue(undefined);
  markSsoBridgeLogoutMock.mockClear();
});

describe("POST /api/auth/logout cookie clearing", () => {
  test("stamps logout authority for a bearer-authenticated hosted session", async () => {
    readStewardSessionTokenMock.mockReturnValue("header.payload.signature");

    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api-staging.elizacloud.ai",
          origin: "https://cloud-staging.eliza.app",
          authorization: "Bearer header.payload.signature",
        },
      },
      { ENVIRONMENT: "staging", NODE_ENV: "production" },
    );

    expect(res.status).toBe(200);
    expect(verifyStewardTokenMock).toHaveBeenCalledWith(
      expect.anything(),
      "header.payload.signature",
    );
    expect(markSsoBridgeLogoutMock).toHaveBeenCalledWith("steward-1");
  });

  test("strong rollout commits the session cutoff before reporting logout success", async () => {
    readStewardSessionTokenMock.mockReturnValue("prod-token");
    getCurrentUserMock.mockResolvedValue({
      id: "user-1",
      organization_id: "org-1",
    });
    revokeInferenceSessionsThroughMock.mockResolvedValue(undefined);
    revokeInferenceSessionsThroughMock.mockClear();

    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api.elizacloud.ai",
          origin: "https://eliza.app",
          cookie: "steward-token=prod-token",
        },
      },
      {
        ENVIRONMENT: "production",
        NODE_ENV: "production",
        INFERENCE_STRONG_REVOCATION_ENABLED: "true",
      },
    );

    expect(res.status).toBe(200);
    expect(revokeInferenceSessionsThroughMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      100,
    );
  });

  test("strong rollout clears cookies but returns 503 when the cutoff is unconfirmed", async () => {
    readStewardSessionTokenMock.mockReturnValue("prod-token");
    getCurrentUserMock.mockResolvedValue({
      id: "user-1",
      organization_id: "org-1",
    });
    revokeInferenceSessionsThroughMock.mockRejectedValueOnce(
      new Error("boundary unavailable"),
    );

    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api.elizacloud.ai",
          origin: "https://eliza.app",
          cookie: "steward-token=prod-token",
        },
      },
      {
        ENVIRONMENT: "production",
        NODE_ENV: "production",
        INFERENCE_STRONG_REVOCATION_ENABLED: "true",
      },
    );

    expect(res.status).toBe(503);
    expect(deletedCookieNames(res)).toContain("steward-token");
    expect((await res.json()) as unknown).toEqual({
      error: "Logout revocation is temporarily unavailable",
      code: "logout_revocation_unavailable",
    });
  });

  test("staging legacy-only logout does not end production user sessions", async () => {
    getCurrentUserMock.mockClear();
    endAllUserSessionsMock.mockClear();

    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api-staging.elizacloud.ai",
          origin: "https://staging.eliza.app",
          cookie:
            "steward-token=prod-token; steward-refresh-token=prod-refresh",
        },
      },
      { ENVIRONMENT: "staging", NODE_ENV: "production" },
    );

    expect(res.status).toBe(200);
    const cleared = deletedCookieNames(res);
    expect(cleared).toContain("steward-token-staging");
    expect(cleared).toContain("steward-refresh-token-staging");
    expect(cleared).toContain("steward-authed-staging");
    expect(cleared).not.toContain("steward-token");
    expect(cleared).not.toContain("steward-refresh-token");
    expect(cleared).not.toContain("steward-authed");
    expect(getCurrentUserMock).not.toHaveBeenCalled();
    expect(endAllUserSessionsMock).not.toHaveBeenCalled();
  });

  test("staging logout does not delete production's unsuffixed steward cookies", async () => {
    getCurrentUserMock.mockClear();
    endAllUserSessionsMock.mockClear();

    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api-staging.elizacloud.ai",
          origin: "https://staging.eliza.app",
          cookie:
            "steward-token=prod-token; steward-refresh-token=prod-refresh; steward-token-staging=staging-token; steward-refresh-token-staging=staging-refresh",
        },
      },
      { ENVIRONMENT: "staging", NODE_ENV: "production" },
    );

    expect(res.status).toBe(200);
    const cleared = deletedCookieNames(res);
    expect(cleared).toContain("steward-token-staging");
    expect(cleared).toContain("steward-refresh-token-staging");
    expect(cleared).toContain("steward-authed-staging");
    expect(cleared).not.toContain("steward-token");
    expect(cleared).not.toContain("steward-refresh-token");
    expect(cleared).not.toContain("steward-authed");
  });

  test("production logout still clears the historical steward cookies", async () => {
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api.elizacloud.ai",
          origin: "https://eliza.app",
          cookie:
            "steward-token=prod-token; steward-refresh-token=prod-refresh",
        },
      },
      { ENVIRONMENT: "production", NODE_ENV: "production" },
    );

    expect(res.status).toBe(200);
    const cleared = deletedCookieNames(res);
    expect(cleared).toContain("steward-token");
    expect(cleared).toContain("steward-refresh-token");
    expect(cleared).toContain("steward-authed");
  });

  test("same-site user-content origin cannot force a production logout", async () => {
    getCurrentUserMock.mockClear();
    endAllUserSessionsMock.mockClear();

    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api.eliza.app",
          origin: "https://attacker.cloud.eliza.app",
          cookie:
            "steward-token=prod-token; steward-refresh-token=prod-refresh",
        },
      },
      { ENVIRONMENT: "production", NODE_ENV: "production" },
    );

    expect(res.status).toBe(403);
    expect((await res.json()) as unknown).toEqual({
      error: "Forbidden",
      code: "forbidden_origin",
    });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(getCurrentUserMock).not.toHaveBeenCalled();
    expect(endAllUserSessionsMock).not.toHaveBeenCalled();
  });

  test("missing browser origin cannot mutate the session", async () => {
    getCurrentUserMock.mockClear();
    endAllUserSessionsMock.mockClear();

    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api.eliza.app",
          cookie:
            "steward-token=prod-token; steward-refresh-token=prod-refresh",
        },
      },
      { ENVIRONMENT: "production", NODE_ENV: "production" },
    );

    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(getCurrentUserMock).not.toHaveBeenCalled();
    expect(endAllUserSessionsMock).not.toHaveBeenCalled();
  });

  test("REGRESSION (#29935): unconfirmed SSO marker after both write attempts → 503, not a 200 success", async () => {
    // Fail closed: if both markSsoBridgeLogout attempts fail, the cross-host
    // logout barrier is not persisted and a paired-origin refresh could
    // re-plant the signed-out session. The route must not report success the
    // client would treat as permission to navigate to /login.
    readStewardSessionTokenMock.mockReturnValue("header.payload.signature");
    markSsoBridgeLogoutMock.mockRejectedValue(new Error("store unavailable"));

    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api-staging.elizacloud.ai",
          origin: "https://cloud-staging.eliza.app",
          authorization: "Bearer header.payload.signature",
        },
      },
      { ENVIRONMENT: "staging", NODE_ENV: "production" },
    );

    expect(res.status).toBe(503);
    expect((await res.json()) as unknown).toEqual({
      error: "Cross-host logout is not yet persisted; retry sign-out",
      code: "logout_marker_unavailable",
    });
    // Cookies are still cleared (this origin IS logged out) and the bounded
    // retry actually ran: exactly two write attempts.
    expect(deletedCookieNames(res)).toContain("steward-token-staging");
    expect(markSsoBridgeLogoutMock).toHaveBeenCalledTimes(2);
  });

  test("REGRESSION (#29935): a transient marker failure recovers on the bounded retry → 200", async () => {
    readStewardSessionTokenMock.mockReturnValue("header.payload.signature");
    // Reset the persistent rejection the previous test installed, then fail
    // exactly the first write: the bounded retry must recover to a 200.
    markSsoBridgeLogoutMock.mockResolvedValue(undefined);
    markSsoBridgeLogoutMock.mockRejectedValueOnce(
      new Error("transient store blip"),
    );

    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api-staging.elizacloud.ai",
          origin: "https://cloud-staging.eliza.app",
          authorization: "Bearer header.payload.signature",
        },
      },
      { ENVIRONMENT: "staging", NODE_ENV: "production" },
    );

    expect(res.status).toBe(200);
    expect(markSsoBridgeLogoutMock).toHaveBeenCalledTimes(2);
    expect((await res.json()) as unknown).toEqual({
      success: true,
      message: "Logged out successfully",
    });
  });

  test("combined failure: revocation 503 takes precedence and the marker failure is not double-reported", async () => {
    // Pin the documented precedence: when both fail-closed flags are set the
    // response is the revocation 503; the marker failure stays visible in the
    // error log and the audit metadata, not the transport body.
    readStewardSessionTokenMock.mockReturnValue("prod-token");
    getCurrentUserMock.mockResolvedValue({
      id: "user-1",
      organization_id: "org-1",
    });
    markSsoBridgeLogoutMock.mockRejectedValue(new Error("store unavailable"));
    revokeInferenceSessionsThroughMock.mockRejectedValue(
      new Error("boundary unavailable"),
    );
    // Calls accumulate across tests (beforeEach clears only the marker mock).
    revokeInferenceSessionsThroughMock.mockClear();

    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api.elizacloud.ai",
          origin: "https://eliza.app",
          cookie: "steward-token=prod-token",
        },
      },
      {
        ENVIRONMENT: "production",
        NODE_ENV: "production",
        INFERENCE_STRONG_REVOCATION_ENABLED: "true",
      },
    );

    expect(res.status).toBe(503);
    expect((await res.json()) as unknown).toEqual({
      error: "Logout revocation is temporarily unavailable",
      code: "logout_revocation_unavailable",
    });
    // Both failure paths still ran their bounded work before the response.
    expect(markSsoBridgeLogoutMock).toHaveBeenCalledTimes(2);
    expect(revokeInferenceSessionsThroughMock).toHaveBeenCalledTimes(1);
  });

  test("characterization (#29935 review): a credential-less retry after a failed first attempt returns success with zero marker writes", async () => {
    // Documents the pre-client-reorder gap: the first attempt 503s, but the
    // develop client has already scrubbed the bearer/cookie by then, so the
    // retry presents no credentials, the marker block is skipped entirely,
    // and the route answers success while the barrier is still unstamped.
    // This is why the client reorder (elizaOS/eliza#29936) is load-bearing —
    // keep this test until that lands; if it ever fails, the sequencing
    // changed and deserves a fresh look.
    readStewardSessionTokenMock.mockReturnValue("header.payload.signature");
    markSsoBridgeLogoutMock.mockRejectedValue(new Error("store unavailable"));

    const first = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api-staging.elizacloud.ai",
          origin: "https://cloud-staging.eliza.app",
          authorization: "Bearer header.payload.signature",
        },
      },
      { ENVIRONMENT: "staging", NODE_ENV: "production" },
    );
    expect(first.status).toBe(503);
    expect(markSsoBridgeLogoutMock).toHaveBeenCalledTimes(2);

    // Retry presents neither Authorization header nor cookie — the token
    // reader is request-mocked, so reflect the absent credentials here.
    markSsoBridgeLogoutMock.mockClear();
    readStewardSessionTokenMock.mockReturnValue(null);
    const second = await app.request(
      "/",
      {
        method: "POST",
        headers: {
          host: "api-staging.elizacloud.ai",
          origin: "https://cloud-staging.eliza.app",
        },
      },
      { ENVIRONMENT: "staging", NODE_ENV: "production" },
    );
    expect(second.status).toBe(200);
    expect(markSsoBridgeLogoutMock).not.toHaveBeenCalled();
    expect((await second.json()) as unknown).toEqual({
      success: true,
      message: "Logged out successfully",
    });
  });
});
