import { beforeEach, describe, expect, mock, test } from "bun:test";

// #11941 — native/desktop Steward JWT refresh. The route must accept a Steward
// token in `Authorization: Bearer` as a cookieless rotation path for
// Capacitor/Electrobun callers, WITHOUT weakening the browser cookie path's
// cross-origin CSRF guard. These tests drive the real Hono handler with the
// Steward upstream + token verification mocked (no live Steward reachable here).

const nowSecs = Math.floor(Date.now() / 1000);

const verifyStewardTokenCached = mock(async () => ({
  userId: "user-1",
  expiration: nowSecs + 3600,
  issuedAt: nowSecs,
}));

mock.module("@/lib/auth/steward-client", () => ({
  STEWARD_AUTH_UPSTREAM_TIMEOUT_MS: 25_000,
  verifyStewardTokenCached,
}));

mock.module("@/lib/steward/sign", () => ({
  signStewardMutatingRequest: mock(async () => {}),
}));

mock.module("@/lib/auth/cookie-domain", () => ({
  cookieDomainForHost: () => undefined,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {} },
}));

const { default: app } = await import("./route");

const ENV = {
  NODE_ENV: "production",
  STEWARD_SESSION_SECRET: "test-secret",
  STEWARD_API_URL: "https://steward.example.test",
  STEWARD_TENANT_ID: "elizacloud",
};

/** Capture the last body the route forwarded to Steward `/auth/refresh`. */
let lastStewardRefreshBody: { refreshToken?: string } | null = null;
const realFetch = globalThis.fetch;

function stewardOk(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      token: "rotated-access-jwt",
      refreshToken: "rotated-refresh-token",
      expiresIn: 3600,
      expiresAt: nowSecs + 3600,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function stewardRejected(): Response {
  return new Response(
    JSON.stringify({ ok: false, error: "refresh token revoked" }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

function mockStewardFetch(response: () => Response): void {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    lastStewardRefreshBody =
      typeof init?.body === "string" ? JSON.parse(init.body) : null;
    return response();
  }) as unknown as typeof fetch;
}

async function post(headers: Record<string, string>): Promise<Response> {
  return app.fetch(
    new Request("https://api.elizacloud.ai/", { method: "POST", headers }),
    ENV,
  );
}

describe("steward-refresh route — Bearer (native/desktop) rotation (#11941)", () => {
  beforeEach(() => {
    verifyStewardTokenCached.mockClear();
    lastStewardRefreshBody = null;
    globalThis.fetch = realFetch;
  });

  test("Bearer path: rotates with the Bearer token and ALWAYS returns the new JWT — no Origin header required", async () => {
    mockStewardFetch(stewardOk);

    // No Origin/Referer + no cookie: the cookie path would 403 on CSRF, but the
    // Bearer path is CSRF-safe and must succeed.
    const res = await post({ authorization: "Bearer native-refresh-token" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token?: string };
    expect(body.ok).toBe(true);
    // Native cannot read the HttpOnly cookie, so the token is always returned.
    expect(body.token).toBe("rotated-access-jwt");
    // The Bearer value (not a cookie) was forwarded to Steward as the refresh
    // credential.
    expect(lastStewardRefreshBody?.refreshToken).toBe("native-refresh-token");
  });

  test("Bearer path: an invalid/expired Bearer is rejected 401 invalid_token", async () => {
    mockStewardFetch(stewardRejected);

    const res = await post({ authorization: "Bearer dead-token" });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("invalid_token");
  });

  test("Bearer path: malformed Authorization header falls through to the cookie path (403 without a cookie/origin)", async () => {
    mockStewardFetch(stewardOk);

    // "Bearer" with no token is not a valid Bearer → treated as cookie path,
    // which rejects a missing origin.
    const res = await post({ authorization: "Bearer " });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("forbidden_origin");
  });

  test("cookie path UNCHANGED: a forbidden cross-origin POST is still rejected 403 (CSRF intact)", async () => {
    mockStewardFetch(stewardOk);

    const res = await post({
      origin: "https://evil.example.com",
      cookie: "steward-refresh-token=cookie-refresh",
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("forbidden_origin");
    // The forbidden request never reached Steward.
    expect(lastStewardRefreshBody).toBeNull();
  });

  test("cookie path UNCHANGED: an allowed first-party origin rotates via the cookie value", async () => {
    mockStewardFetch(stewardOk);

    const res = await post({
      origin: "https://elizacloud.ai",
      cookie: "steward-refresh-token=cookie-refresh",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token?: string };
    expect(body.ok).toBe(true);
    // elizacloud.ai is a trusted origin → token mirrored back (unchanged).
    expect(body.token).toBe("rotated-access-jwt");
    // The COOKIE value (not a Bearer) was forwarded to Steward.
    expect(lastStewardRefreshBody?.refreshToken).toBe("cookie-refresh");
  });

  test("no credential (no Bearer, no cookie) on an allowed origin → 401 missing_token", async () => {
    mockStewardFetch(stewardOk);

    const res = await post({ origin: "https://elizacloud.ai" });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("missing_token");
  });
});
