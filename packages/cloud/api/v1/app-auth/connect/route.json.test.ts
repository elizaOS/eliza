/**
 * Exercises malformed request input with deterministic route collaborators,
 * plus the cookie-mutation CSRF guard: connect requests riding the ambient
 * Steward session cookie need a first-party Origin + non-simple marker, while
 * header-credential (Bearer/API-key) callers are unaffected.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const APP_ID = "00000000-0000-4000-8000-0000000000aa";
const connectUser = mock(async () => "created");
const issueAppAuthCode = mock(async () => ({
  code: "auth-1",
  expiresAt: "2026-01-01T00:00:00.000Z",
  expiresIn: 60,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKey: async () => ({ id: "user-1" }),
  // route.ts's mobile_pkce branch also imports requireUserWithOrg — an
  // incomplete mock leaves that named export missing and fails module
  // resolution for every test in this file before any test body runs.
  requireUserWithOrg: async () => ({ id: "user-1" }),
}));

mock.module("@/db/repositories/apps", () => ({
  appsRepository: {
    findPublicInfoById: async () => ({ id: APP_ID }),
    connectUser,
  },
}));

mock.module("@/lib/services/apps", () => ({
  appsService: { getAllowedOrigins: async () => [] },
}));

mock.module("@/lib/services/app-auth-codes", () => ({
  issueAppAuthCode,
}));

mock.module("@/lib/security/origin-validation", () => ({
  isAllowedOrigin: () => true,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    error: () => undefined,
    warn: () => undefined,
  },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/app-auth/connect malformed JSON", () => {
  test("returns 400 instead of 500 and never connects", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(connectUser).not.toHaveBeenCalled();
    expect(issueAppAuthCode).not.toHaveBeenCalled();
  });

  test("canonical JSON still issues an auth code", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: APP_ID }),
    });
    expect(response.status).toBe(200);
    expect(issueAppAuthCode).toHaveBeenCalled();
  });
});

describe("POST /api/v1/app-auth/connect cookie-mutation guard", () => {
  const COOKIE = "steward-token=session-1";

  beforeEach(() => {
    connectUser.mockClear();
    issueAppAuthCode.mockClear();
  });

  test("cookie-authed connect with no Origin/Referer → 403, never connects", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: COOKIE },
      body: JSON.stringify({ appId: APP_ID }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "forbidden_origin",
    });
    expect(connectUser).not.toHaveBeenCalled();
    expect(issueAppAuthCode).not.toHaveBeenCalled();
  });

  test("cookie-authed connect from a hosted-content origin → 403", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: COOKIE,
        origin: "https://evil.sites.eliza.app",
      },
      body: JSON.stringify({ appId: APP_ID }),
    });
    expect(response.status).toBe(403);
    expect(connectUser).not.toHaveBeenCalled();
  });

  test("cookie-authed connect from the Eliza app origin with a JSON marker → 200", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: COOKIE,
        origin: "https://cloud.eliza.app",
      },
      body: JSON.stringify({ appId: APP_ID }),
    });
    expect(response.status).toBe(200);
    expect(issueAppAuthCode).toHaveBeenCalled();
  });
});
