/**
 * Logout enforces the Steward mutation origin policy while keeping production
 * and staging cookie names isolated. The harness mocks teardown collaborators
 * but exercises the real route and cookie headers.
 */

import { describe, expect, mock, test } from "bun:test";

const getCurrentUserMock = mock(async () => null);
const endAllUserSessionsMock = mock(async () => undefined);

mock.module("@/lib/auth", () => ({
  invalidateSessionCaches: mock(async () => undefined),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser: getCurrentUserMock,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/services/user-sessions", () => ({
  userSessionsService: {
    endAllUserSessions: endAllUserSessionsMock,
  },
}));

mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({
    emit: mock(async () => undefined),
  }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
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

describe("POST /api/auth/logout cookie clearing", () => {
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
});
