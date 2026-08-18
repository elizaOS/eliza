/**
 * Security contract for POST /api/set-anonymous-session (W5-010). The route
 * plants the `eliza-anon-session` cookie from a caller-supplied token, so it
 * must be gated like the other session mutations: exact-host Origin policy
 * plus a non-simple-request marker, and a SameSite=Strict cookie — otherwise a
 * cross-site form POST could plant an attacker-known session into a victim's
 * browser. These tests drive the REAL Hono route and the REAL
 * browser-origin-policy; only the deep persistence edges are stubbed.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";

const SESSION_TOKEN = "deployment-minted-session-token";
const EXPIRES_AT = new Date(Date.now() + 60_000);

let sessionForToken: Record<string, unknown> | null = null;
const getByToken = mock(async () => sessionForToken);
const getUserById = mock(async () => ({
  id: "anon-user-1",
  is_anonymous: true,
}));

mock.module("@/db/client", () => ({
  dbWrite: {
    insert: () => {
      throw new Error("dbWrite.insert must not run in these tests");
    },
    update: () => {
      throw new Error("dbWrite.update must not run in these tests");
    },
  },
}));
mock.module("@/db/schemas", () => ({
  anonymousSessions: { id: "anonymous_sessions.id" },
  users: { id: "users.id" },
}));
mock.module("@/lib/services/anonymous-sessions", () => ({
  anonymousSessionsService: { getByToken },
}));
mock.module("@/lib/services/users", () => ({
  usersService: { getById: getUserById },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

// Import AFTER the mocks are registered so the route binds the stubs.
const { default: app } = await import("../set-anonymous-session/route");

const PROD_ENV = { NODE_ENV: "production" } as unknown as Record<
  string,
  unknown
>;
const DEV_ENV = { NODE_ENV: "test" } as unknown as Record<string, unknown>;

function post(input: {
  origin?: string | null;
  referer?: string | null;
  contentType?: string;
  csrfHeader?: boolean;
  sessionToken?: string;
  env?: Record<string, unknown>;
}) {
  const headers: Record<string, string> = {
    host: "api.eliza.app",
    "content-type": input.contentType ?? "application/json",
  };
  if (input.origin) headers.origin = input.origin;
  if (input.referer) headers.referer = input.referer;
  if (input.csrfHeader) headers["x-eliza-csrf"] = "1";
  return app.request(
    "https://api.eliza.app/",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionToken: input.sessionToken ?? SESSION_TOKEN,
      }),
    },
    input.env ?? PROD_ENV,
  );
}

describe("set-anonymous-session — cross-site cookie-planting gate (W5-010)", () => {
  beforeEach(() => {
    getByToken.mockClear();
    getUserById.mockClear();
    sessionForToken = {
      id: "anon-session-1",
      user_id: "anon-user-1",
      expires_at: EXPIRES_AT,
    };
  });

  test("a first-party origin with the JSON marker sets a SameSite=Strict cookie", async () => {
    const res = await post({ origin: "https://cloud.eliza.app" });

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("eliza-anon-session=");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("SameSite=Lax");
    expect(setCookie).toContain("HttpOnly");
  });

  test("a cross-site origin is rejected 403 before any session lookup", async () => {
    const res = await post({ origin: "https://evil.example.com" });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "forbidden_origin",
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(getByToken).not.toHaveBeenCalled();
  });

  test("user content on a sibling eliza.app subdomain is not a permitted origin", async () => {
    const res = await post({ origin: "https://attacker.sites.eliza.app" });

    expect(res.status).toBe(403);
    expect(getByToken).not.toHaveBeenCalled();
  });

  test("a missing Origin and Referer is rejected 403", async () => {
    const res = await post({});

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "forbidden_origin",
    });
    expect(getByToken).not.toHaveBeenCalled();
  });

  test("a permitted origin without a non-simple-request marker is rejected 403", async () => {
    // A cross-site form POST can only send simple requests (no custom headers,
    // no JSON content type), so this is the leg that stops JSON smuggling via
    // text/plain even if an origin check were ever bypassed.
    const res = await post({
      origin: "https://cloud.eliza.app",
      contentType: "text/plain",
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "csrf_marker_required",
    });
    expect(getByToken).not.toHaveBeenCalled();
  });

  test("the X-Eliza-CSRF header satisfies the marker leg", async () => {
    const res = await post({
      origin: "https://cloud.eliza.app",
      contentType: "text/plain",
      csrfHeader: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("SameSite=Strict");
  });

  test("localhost origins are only permitted outside production", async () => {
    const devRes = await post({
      origin: "http://localhost:3000",
      env: DEV_ENV,
    });
    expect(devRes.status).toBe(200);

    const prodRes = await post({ origin: "http://localhost:3000" });
    expect(prodRes.status).toBe(403);
  });

  test("a token the deployment never minted is rejected 404", async () => {
    sessionForToken = null;

    const res = await post({
      origin: "https://cloud.eliza.app",
      sessionToken: "attacker-invented-token",
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
