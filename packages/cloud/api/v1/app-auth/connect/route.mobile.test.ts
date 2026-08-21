/**
 * Exercises the first-party mobile branch of browser approval, including its
 * session-only boundary and server-owned app registration.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const { AuthenticationError } = await import("@/lib/api/cloud-worker-errors");
const mobileService = await import("@/lib/services/mobile-app-auth");

const APP_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION_ID = "33333333-3333-4333-8333-333333333333";
const STATE = "state_abcdefghijklmnopqrstuvwxyz0123456789-._~";
const CHALLENGE = "a".repeat(43);
const registration = {
  appId: APP_ID,
  clientId: "ai.elizaos.app" as const,
  environment: "staging" as const,
  redirectUri: "https://eliza.app/auth/callback" as const,
  scopes: ["cloud:user"] as const,
};

let rejectSession = false;
const requireUserWithOrg = mock(async () => {
  if (rejectSession) throw AuthenticationError("Interactive session required");
  return {
    id: USER_ID,
    organization_id: ORGANIZATION_ID,
    organization: { id: ORGANIZATION_ID, is_active: true },
  };
});
const requireUserOrApiKey = mock(async () => {
  throw new Error("mobile approval must not use API-key-compatible auth");
});
const connectUser = mock(async () => "created" as const);
const issueMobileAppAuthCode = mock(async () => ({
  code: `emac_${"a".repeat(64)}`,
  expiresAt: "2026-07-15T12:05:00.000Z",
  expiresIn: 300,
}));
let rejectAdmission = false;
const runMobileAppAuthGrantAdmission = mock(
  async (
    c: { json(value: unknown, status?: number): Response },
    _userId: string,
    createGrant: () => Promise<Response>,
  ) =>
    rejectAdmission
      ? c.json(
          {
            success: false,
            code: "rate_limit_exceeded",
            error: "Too many requests",
          },
          429,
        )
      : await createGrant(),
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKey,
  requireUserWithOrg,
}));
mock.module("@/db/repositories/apps", () => ({
  appsRepository: {
    connectUser,
    findById: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/apps", () => ({
  appsService: { getAllowedOrigins: mock(async () => []) },
}));
mock.module("@/lib/services/app-auth-codes", () => ({
  issueAppAuthCode: mock(async () => {
    throw new Error("legacy branch not expected");
  }),
}));
mock.module("@/lib/services/mobile-app-auth", () => ({
  ...mobileService,
  issueMobileAppAuthCode,
}));
mock.module("../mobile/_rate-limit", () => ({
  runMobileAppAuthGrantAdmission,
}));
mock.module("../mobile/_registration", () => ({
  requireRegisteredMobileApp: mock(async () => ({
    registration,
    app: { id: APP_ID, name: "Eliza mobile" },
  })),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

function requestBody() {
  return {
    flow: "mobile_pkce",
    clientId: registration.clientId,
    environment: registration.environment,
    redirectUri: registration.redirectUri,
    state: STATE,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
  };
}

async function approve(body: unknown = requestBody()): Promise<Response> {
  return await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function approveMalformedJson(): Promise<Response> {
  return await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
}

beforeEach(() => {
  rejectSession = false;
  rejectAdmission = false;
  requireUserWithOrg.mockClear();
  requireUserOrApiKey.mockClear();
  connectUser.mockClear();
  issueMobileAppAuthCode.mockClear();
  runMobileAppAuthGrantAdmission.mockClear();
});

describe("POST /api/v1/app-auth/connect mobile PKCE branch", () => {
  test("uses the interactive session and server registration without exposing appId", async () => {
    const response = await approve();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      success: true,
      codeType: "mobile_app_auth_code",
      expiresIn: 300,
    });
    expect(JSON.stringify(body)).not.toContain(APP_ID);
    expect(requireUserWithOrg).toHaveBeenCalledTimes(1);
    expect(requireUserOrApiKey).not.toHaveBeenCalled();
    expect(connectUser).toHaveBeenCalledWith(
      expect.objectContaining({ appId: APP_ID, userId: USER_ID }),
    );
    expect(issueMobileAppAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({
        registration,
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
      }),
    );
  });

  test("returns the canonical 401 when no interactive session exists", async () => {
    rejectSession = true;
    const response = await approve();
    expect(response.status).toBe(401);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      success: false,
      code: "authentication_required",
    });
    expect(connectUser).not.toHaveBeenCalled();
    expect(issueMobileAppAuthCode).not.toHaveBeenCalled();
  });

  test("rejects missing state before creating a connection or grant", async () => {
    const { state: _state, ...withoutState } = requestBody();
    const response = await approve(withoutState);
    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      success: false,
      error: "invalid_request",
    });
    expect(requireUserWithOrg).not.toHaveBeenCalled();
    expect(connectUser).not.toHaveBeenCalled();
  });

  test("rejects malformed JSON as a caller error before authentication or writes", async () => {
    const response = await approveMalformedJson();
    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: "Invalid JSON body",
    });
    expect(requireUserWithOrg).not.toHaveBeenCalled();
    expect(requireUserOrApiKey).not.toHaveBeenCalled();
    expect(connectUser).not.toHaveBeenCalled();
    expect(issueMobileAppAuthCode).not.toHaveBeenCalled();
  });

  test("validates the exact registered binding before creating a connection", async () => {
    const response = await approve({
      ...requestBody(),
      redirectUri: "https://attacker.example/callback",
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      success: false,
      error: "binding_mismatch",
    });
    expect(requireUserWithOrg).toHaveBeenCalledTimes(1);
    expect(connectUser).not.toHaveBeenCalled();
    expect(issueMobileAppAuthCode).not.toHaveBeenCalled();
  });

  test("does not create a connection or grant when dedicated admission rejects", async () => {
    rejectAdmission = true;
    const response = await approve();
    expect(response.status).toBe(429);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      success: false,
      code: "rate_limit_exceeded",
    });
    expect(runMobileAppAuthGrantAdmission).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      expect.any(Function),
    );
    expect(connectUser).not.toHaveBeenCalled();
    expect(issueMobileAppAuthCode).not.toHaveBeenCalled();
  });
});
