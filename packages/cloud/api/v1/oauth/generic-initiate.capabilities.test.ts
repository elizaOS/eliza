/**
 * Exercises capability-based generic OAuth initiation through the HTTP
 * boundary with deterministic auth and provider adapters.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, error: unknown) => {
    throw error;
  },
  ApiError: class ApiError extends Error {},
}));
mock.module("@/lib/api/errors", () => ({
  ApiError: class ApiError extends Error {},
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    error: mock(() => undefined),
  },
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: mock(async () => ({
    id: "user-1",
    organization_id: "org-1",
  })),
}));

const provider = {
  id: "google",
  name: "Google",
  description: "Google",
  type: "oauth2",
  envVars: [],
  useGenericRoutes: true,
  defaultScopes: ["identity"],
  storage: "platform_credentials",
} as const;
mock.module("@/lib/services/oauth/provider-registry", () => ({
  getProvider: (id: string) => (id === "google" ? provider : null),
  isProviderConfigured: () => true,
}));

const initiateAuth = mock(
  async (params: {
    capabilities?: string[];
    scopes?: string[];
    redirectUrl?: string;
    connectionId?: string;
    capabilityRequest?: unknown;
  }) => ({
    authUrl: "https://accounts.example/authorize",
    state: "state-1",
    capabilityAccess: params.capabilities?.map((capabilityId) => ({
      capabilityId,
      riskLevel: "R1" as const,
      status: "needs_scope" as const,
      missingScopes: ["calendar.read"],
      missingUserScopes: [],
    })),
    retryAfterConsent: params.capabilityRequest !== undefined,
  }),
);
mock.module("@/lib/services/oauth", () => ({
  OAuthError: class OAuthError extends Error {},
  oauthService: { initiateAuth },
}));

const { handleGenericOAuthInitiate } = await import("./generic-initiate");

function request(body: unknown): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.post("/api/v1/oauth/google/initiate", (c) =>
    handleGenericOAuthInitiate(c, "google"),
  );
  return Promise.resolve(
    app.request("/api/v1/oauth/google/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("generic OAuth capability initiation (#19879)", () => {
  beforeEach(() => initiateAuth.mockClear());

  test("returns the consent state and preserves the retry redirect", async () => {
    const response = await request({
      capabilities: ["calendar.events.read"],
      redirectUrl: "/cloud/calendar?retry=intent-1",
    });

    expect(response.status).toBe(200);
    expect(initiateAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "google",
        capabilities: ["calendar.events.read"],
        scopes: undefined,
        redirectUrl: "/cloud/calendar?retry=intent-1",
      }),
    );
    expect(await response.json()).toMatchObject({
      capabilityAccess: [
        {
          capabilityId: "calendar.events.read",
          status: "needs_scope",
        },
      ],
      retryAfterConsent: false,
    });
  });

  test("passes the explicit connection binding used to inspect existing grants", async () => {
    const response = await request({
      capabilities: ["calendar.events.read"],
      connectionId: "11111111-1111-4111-8111-111111111111",
    });

    expect(response.status).toBe(200);
    expect(initiateAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "11111111-1111-4111-8111-111111111111",
      }),
    );
  });

  test.each([
    { capabilities: [] },
    { capabilities: "calendar.events.read" },
    { capabilities: [" "] },
  ])("rejects malformed capability input %#", async (body) => {
    const response = await request(body);
    expect(response.status).toBe(400);
    expect(initiateAuth).not.toHaveBeenCalled();
  });

  test("rejects ambiguous raw-scope and capability requests", async () => {
    const response = await request({
      scopes: ["calendar.read"],
      capabilities: ["calendar.events.read"],
    });
    expect(response.status).toBe(400);
    expect(initiateAuth).not.toHaveBeenCalled();
  });

  test("rejects a connection binding without named capabilities", async () => {
    const response = await request({
      connectionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(response.status).toBe(400);
    expect(initiateAuth).not.toHaveBeenCalled();
  });

  test("rejects a malformed connection binding before tenant lookup", async () => {
    const response = await request({
      capabilities: ["calendar.events.read"],
      connectionId: "not-a-uuid",
    });
    expect(response.status).toBe(400);
    expect(initiateAuth).not.toHaveBeenCalled();
  });

  test("preserves the legacy raw-scope request path", async () => {
    const response = await request({ scopes: ["identity"] });
    expect(response.status).toBe(200);
    expect(initiateAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ["identity"],
        capabilities: undefined,
      }),
    );
    expect(await response.json()).toMatchObject({ retryAfterConsent: false });
  });

  test("forwards an exact request only through the authenticated continuation", async () => {
    const capabilityRequest = {
      contractVersion: 2,
      requestId: "req_calendar_1",
      capabilityId: "calendar.events.read",
      operation: "calendar.events.list",
      riskLevel: "R1",
      accountId: null,
      inputDigest: "a".repeat(64),
    };
    const response = await request({
      capabilities: ["calendar.events.read"],
      capabilityRequest,
    });

    expect(response.status).toBe(200);
    expect(initiateAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityRequest,
        redirectUrl: "/auth/success",
      }),
    );
    expect(await response.json()).toMatchObject({ retryAfterConsent: true });
  });
});
