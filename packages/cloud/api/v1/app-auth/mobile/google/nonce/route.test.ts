/** Exercises the public Google challenge issuance boundary without weakening its registration or PKCE gates. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppEnv } from "@/types/cloud-worker-env";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const BODY = {
  clientId: "ai.elizaos.app",
  environment: "staging",
  redirectUri: "https://eliza.app/auth/callback",
  state: "s".repeat(43),
  codeChallenge: "c".repeat(43),
  codeChallengeMethod: "S256",
  deviceName: "Pixel 11 Pro",
};
let ready = true;
let issueError: Error | null = null;

const mobileAuth = await import("@/lib/services/mobile-app-auth");
mock.module("@/lib/services/mobile-app-auth", () => ({
  ...mobileAuth,
  validateMobileAppAuthPkceBinding: mobileAuth.validateMobileAppAuthPkceBinding,
}));
mock.module("@/lib/services/mobile-google-auth", () => ({
  resolveMobileGoogleAuthReadiness: mock(() =>
    ready ? { ready: true } : null,
  ),
  issueMobileGoogleAuthNonce: mock(async () => {
    if (issueError) throw issueError;
    return {
      nonce: "a".repeat(64),
      expiresAt: "2026-08-25T12:05:00.000Z",
    };
  }),
}));
mock.module("../../_registration", () => ({
  requireRegisteredMobileApp: mock(async () => ({
    app: { id: APP_ID },
    registration: {
      appId: APP_ID,
      clientId: BODY.clientId,
      environment: BODY.environment,
      redirectUri: BODY.redirectUri,
      scopes: ["cloud:user"],
    },
  })),
}));
mock.module("../../_rate-limit", () => ({
  MOBILE_APP_AUTH_TOKEN_RATE_LIMIT: {},
  mobileAppAuthRateLimitMiddleware:
    () =>
    async (_context: unknown, next: () => Promise<void>): Promise<void> =>
      await next(),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");
const env = { ENVIRONMENT: "staging" } as AppEnv["Bindings"];

function request(body: unknown = BODY): Request {
  return new Request("https://api-staging.eliza.app/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  ready = true;
  issueError = null;
});

describe("POST /api/v1/app-auth/mobile/google/nonce", () => {
  test("returns only the issued challenge and expiry", async () => {
    const response = await app.fetch(request(), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: true,
      nonce: "a".repeat(64),
      expiresAt: "2026-08-25T12:05:00.000Z",
    });
  });

  test("rejects malformed input before issuing", async () => {
    const response = await app.fetch(request({ ...BODY, state: "short" }), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
      retryable: false,
    });
  });

  test("does not advertise a challenge when static readiness is incomplete", async () => {
    ready = false;
    const response = await app.fetch(request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "server_configuration_error",
      retryable: false,
    });
  });

  test("maps Redis issuance failures to a retryable dependency response", async () => {
    issueError = new Error("redis unavailable");
    const response = await app.fetch(request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "temporarily_unavailable",
      retryable: true,
    });
  });
});
