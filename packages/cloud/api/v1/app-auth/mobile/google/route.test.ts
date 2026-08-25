/**
 * Drives the Google native HTTP boundary with deterministic Steward responses,
 * proving verification precedes one-time challenge consumption and dependency
 * failures remain retryable without weakening invalid-identity responses.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { MobileAppAuthPkceBinding } from "@/lib/services/mobile-app-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const NONCE = "a".repeat(64);
const BINDING: MobileAppAuthPkceBinding = {
  clientId: "ai.elizaos.app",
  environment: "staging",
  redirectUri: "https://eliza.app/auth/callback",
  state: "s".repeat(43),
  codeChallenge: "c".repeat(43),
  codeChallengeMethod: "S256",
  deviceName: "Pixel 11 Pro",
};
const APP_ID = "11111111-1111-4111-8111-111111111111";
const events: string[] = [];
let consumeResult = true;
let verifiedClaims: Record<string, unknown> | null = {
  userId: "steward-user",
  email: "owner@example.test",
};
const signStewardMutatingRequest = mock(
  async (_secret: string, _method: string, _path: string, headers: Headers) => {
    events.push("sign");
    headers.set("x-steward-signature", "v1=test-signature");
  },
);

const mobileAuth = await import("@/lib/services/mobile-app-auth");
mock.module("@/lib/services/mobile-app-auth", () => ({
  ...mobileAuth,
  issueMobileAppAuthCode: mock(async () => ({
    code: `emac_${"b".repeat(64)}`,
    expiresIn: 300,
    expiresAt: "2026-08-25T12:05:00.000Z",
  })),
}));
mock.module("@/lib/services/mobile-google-auth", () => ({
  resolveMobileGoogleAuthReadiness: mock(() => ({
    serverClientId: "google-web-client.apps.googleusercontent.com",
    stewardEndpoint: new URL(
      "https://api-staging.eliza.app/steward/auth/oauth/google/id-token",
    ),
    stewardRequestSigningSecret: "request-signing-secret",
    tenantId: "elizacloud-staging",
  })),
  consumeMobileGoogleAuthNonce: mock(async () => {
    events.push("consume");
    return consumeResult;
  }),
}));
mock.module("@/lib/auth/steward-client", () => ({
  STEWARD_AUTH_UPSTREAM_TIMEOUT_MS: 5_000,
  verifyStewardTokenCached: mock(async () => {
    events.push("verify");
    return verifiedClaims;
  }),
}));
mock.module("@/lib/steward/sign", () => ({
  signStewardMutatingRequest,
}));
mock.module("@/lib/steward-sync", () => ({
  describeSyncError: mock((error: unknown) => String(error)),
  syncUserFromSteward: mock(async () => ({
    id: "cloud-user",
    organization_id: "cloud-org",
  })),
}));
mock.module("@/db/repositories/apps", () => ({
  appsRepository: {
    connectUser: mock(async () => undefined),
  },
}));
mock.module("../_registration", () => ({
  requireRegisteredMobileApp: mock(async () => ({
    app: { id: APP_ID },
    registration: {
      appId: APP_ID,
      clientId: BINDING.clientId,
      environment: BINDING.environment,
      redirectUri: BINDING.redirectUri,
      scopes: ["cloud:user"],
    },
  })),
}));
mock.module("../_rate-limit", () => ({
  MOBILE_APP_AUTH_TOKEN_RATE_LIMIT: {},
  mobileAppAuthRateLimitMiddleware:
    () =>
    async (_context: unknown, next: () => Promise<void>): Promise<void> =>
      await next(),
  runMobileAppAuthGrantAdmission: mock(
    async (
      _context: unknown,
      _userId: string,
      createGrant: () => Promise<Response>,
    ) => await createGrant(),
  ),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");
const env = { ENVIRONMENT: "staging" } as AppEnv["Bindings"];
const originalFetch = globalThis.fetch;

function googleToken(nonce: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode({ nonce, sub: "google-user" })}.${"c".repeat(80)}`;
}

function request(overrides: Record<string, unknown> = {}): Request {
  return new Request("https://api-staging.eliza.app/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...BINDING,
      googleIdToken: googleToken(NONCE),
      nonce: NONCE,
      ...overrides,
    }),
  });
}

beforeEach(() => {
  events.length = 0;
  signStewardMutatingRequest.mockClear();
  consumeResult = true;
  verifiedClaims = {
    userId: "steward-user",
    email: "owner@example.test",
  };
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      events.push("steward");
      expect(String(input)).toBe(
        "https://api-staging.eliza.app/steward/auth/oauth/google/id-token",
      );
      expect(new Headers(init?.headers).get("x-steward-signature")).toBe(
        "v1=test-signature",
      );
      return Response.json({ ok: true, token: "steward-session" });
    },
  ) as unknown as typeof fetch;
});

describe("POST /api/v1/app-auth/mobile/google", () => {
  test("verifies Steward before atomically consuming the challenge", async () => {
    const response = await app.fetch(request(), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      codeType: "mobile_app_auth_code",
    });
    expect(events.slice(0, 4)).toEqual([
      "sign",
      "steward",
      "verify",
      "consume",
    ]);
    expect(signStewardMutatingRequest).toHaveBeenCalledWith(
      "request-signing-secret",
      "POST",
      "/steward/auth/oauth/google/id-token",
      expect.any(Headers),
      expect.any(Uint8Array),
    );
  });

  test("rejects a nonce claim mismatch before Steward or Redis", async () => {
    const response = await app.fetch(
      request({ googleIdToken: googleToken("b".repeat(64)) }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "binding_mismatch",
      retryable: false,
    });
    expect(events).toEqual([]);
  });

  test("an invalid verified session cannot burn the challenge", async () => {
    verifiedClaims = null;
    const response = await app.fetch(request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "temporarily_unavailable",
      retryable: true,
    });
    expect(events).toEqual(["sign", "steward", "verify"]);
  });

  test("a replayed or expired challenge is a nonretryable binding mismatch", async () => {
    consumeResult = false;
    const response = await app.fetch(request(), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "binding_mismatch",
      retryable: false,
    });
  });

  test("only structured identity rejections are nonretryable", async () => {
    for (const [status, code] of [
      [401, "google_token_invalid"],
      [401, "google_token_replayed"],
      [403, "google_email_unverified"],
      [403, "google_policy_denied"],
      [409, "google_account_conflict"],
    ] as const) {
      globalThis.fetch = mock(async () =>
        Response.json({ ok: false, code }, { status }),
      ) as unknown as typeof fetch;
      const response = await app.fetch(request(), env);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "invalid_request",
        retryable: false,
      });
    }
  });

  test("signature, route, configuration, throttling, and outage failures remain retryable", async () => {
    for (const [status, body] of [
      [400, { ok: false, code: "google_tenant_mismatch" }],
      [401, { ok: false, error: "Invalid request signature" }],
      [404, { ok: false, error: "Not found" }],
      [408, { ok: false, error: "Timeout" }],
      [429, { ok: false, code: "google_rate_limited" }],
      [500, { ok: false, error: "Failure" }],
      [503, { ok: false, code: "google_not_configured" }],
    ] as const) {
      globalThis.fetch = mock(async () =>
        Response.json(body, { status }),
      ) as unknown as typeof fetch;
      const response = await app.fetch(request(), env);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: "temporarily_unavailable",
        retryable: true,
      });
    }
  });

  test("invalid success JSON and fetch failures are retryable dependency errors", async () => {
    globalThis.fetch = mock(
      async () => new Response("not-json"),
    ) as unknown as typeof fetch;
    const invalidJson = await app.fetch(request(), env);
    expect(invalidJson.status).toBe(503);
    expect(await invalidJson.json()).toMatchObject({ retryable: true });

    globalThis.fetch = mock(async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    const unavailable = await app.fetch(request(), env);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ retryable: true });
  });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});
