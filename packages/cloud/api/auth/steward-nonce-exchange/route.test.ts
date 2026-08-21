/**
 * POST /api/auth/steward-nonce-exchange contract: PKCE verifier is required,
 * the non-simple-request marker is required alongside the exact-host origin
 * policy, the verifier is forwarded to the Steward exchange, and the
 * long-lived refresh token is never mirrored into the JSON body.
 * Route handler is real; Steward upstream, token verification, and user sync
 * are mocked.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const verifyCalls: string[] = [];
let upstreamBodies: string[] = [];

mock.module("@/lib/auth/steward-client", () => ({
  STEWARD_AUTH_UPSTREAM_TIMEOUT_MS: 5_000,
  verifyStewardTokenCached: async (_env: unknown, token: string) => {
    verifyCalls.push(token);
    if (token !== "steward-jwt") return null;
    return {
      userId: "steward-user-1",
      email: "user@example.test",
      tenantId: "elizacloud",
      expiration: Math.floor(Date.now() / 1000) + 3600,
    };
  },
}));

mock.module("@/lib/steward-sync", () => ({
  describeSyncError: (error: unknown) => String(error),
  StewardTelegramAccountClaimError: class extends Error {},
  syncUserFromSteward: async () => ({
    id: "cloud-user-1",
    organization_id: "org-1",
    initialCreditsGranted: false,
    initialFreeCreditsUsd: 0,
    welcomeBonusWithheld: false,
  }),
}));

mock.module("@/lib/steward/sign", () => ({
  signStewardMutatingRequest: async () => undefined,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

const { default: route } = await import("./route");

const ENV = {
  NODE_ENV: "test",
  STEWARD_API_URL: "https://steward.example.test",
  STEWARD_SESSION_SECRET: "test-secret",
} as never;

const originalFetch = globalThis.fetch;

function buildApp() {
  const app = new Hono();
  app.route("/api/auth/steward-nonce-exchange", route);
  return app;
}

function postExchange(headers: Record<string, string>, body?: unknown) {
  return buildApp().request(
    "/api/auth/steward-nonce-exchange",
    {
      method: "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    ENV,
  );
}

const FIRST_PARTY = {
  origin: "http://localhost:3000",
  "content-type": "application/json",
};

beforeEach(() => {
  verifyCalls.length = 0;
  upstreamBodies = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    upstreamBodies.push(String(init?.body ?? ""));
    return new Response(
      JSON.stringify({
        ok: true,
        token: "steward-jwt",
        refreshToken: "steward-refresh",
        expiresIn: 3600,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("POST /api/auth/steward-nonce-exchange", () => {
  test("rejects requests with no Origin or Referer", async () => {
    const res = await postExchange(
      { "content-type": "application/json" },
      { code: "c", redirectUri: "https://eliza.app/login" },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden_origin" });
  });

  test("rejects a simple request without the non-simple marker", async () => {
    const res = await postExchange(
      { origin: "http://localhost:3000", "content-type": "text/plain" },
      { code: "c", redirectUri: "https://eliza.app/login" },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "csrf_marker_required" });
  });

  test("rejects a verifier-less exchange", async () => {
    const res = await postExchange(FIRST_PARTY, {
      code: "one-time-code",
      redirectUri: "https://eliza.app/login",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "missing_code_verifier" });
    expect(upstreamBodies).toHaveLength(0);
  });

  test("forwards the verifier upstream and never mirrors the refresh token", async () => {
    const res = await postExchange(FIRST_PARTY, {
      code: "one-time-code",
      redirectUri: "https://eliza.app/login",
      codeVerifier: "pkce-verifier",
    });
    expect(res.status).toBe(200);

    expect(upstreamBodies).toHaveLength(1);
    const upstream = JSON.parse(upstreamBodies[0] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(upstream.code_verifier).toBe("pkce-verifier");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // The SPA needs the short-lived access-token mirror; the long-lived
    // refresh token must stay inside the HttpOnly cookie.
    expect(body.token).toBe("steward-jwt");
    expect(body).not.toHaveProperty("refreshToken");

    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toContain("steward-refresh-token");
    expect(verifyCalls).toEqual(["steward-jwt"]);
  });
});
