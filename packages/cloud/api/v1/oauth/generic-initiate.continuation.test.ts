/** Verifies the authenticated generic OAuth boundary persists capability intent only in server state. */

import { describe, expect, mock, test } from "bun:test";
import * as realProviderRegistry from "@/lib/services/oauth/provider-registry";
import * as realOAuthProviders from "@/lib/services/oauth/providers";

const initiateOAuth2 = mock(async () => ({
  authUrl: "https://provider.example/authorize?state=opaque",
  state: "opaque",
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "22222222-2222-4222-8222-222222222222",
  }),
}));

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findByIdAndOrg: async () => ({
      id: "33333333-3333-4333-8333-333333333333",
      user_id: "11111111-1111-4111-8111-111111111111",
    }),
  },
}));

mock.module("@/lib/services/oauth/provider-registry", () => ({
  ...realProviderRegistry,
  getProvider: () => ({
    id: "google",
    name: "Google",
    type: "oauth2",
    useGenericRoutes: true,
    envVars: [],
    defaultScopes: [],
  }),
  isProviderConfigured: () => true,
}));

mock.module("@/lib/services/oauth/providers", () => ({
  ...realOAuthProviders,
  initiateOAuth2,
}));

describe("generic OAuth capability continuation", () => {
  test("passes a user/org/agent/provider-bound continuation to server-side OAuth state", async () => {
    const { handleGenericOAuthInitiate } = await import("./generic-initiate");
    const body = {
      agentId: "33333333-3333-4333-8333-333333333333",
      continuation: {
        originalIntent: "find a time with Maya",
        capabilityId: "calendar",
        clientMessageId: "turn-1",
        requiresConfirmation: true,
      },
    };
    const context = {
      req: { json: async () => body },
      json: (value: unknown, status = 200) => Response.json(value, { status }),
    };

    const response = await handleGenericOAuthInitiate(
      context as never,
      "google",
    );
    expect(response.status).toBe(200);
    expect(initiateOAuth2).toHaveBeenCalledTimes(1);
    const initiation = initiateOAuth2.mock.calls[0]?.[1];
    if (!initiation) throw new Error("OAuth initiation was not called");
    expect(initiation).toMatchObject({
      organizationId: "22222222-2222-4222-8222-222222222222",
      userId: "11111111-1111-4111-8111-111111111111",
      capabilityContinuation: {
        agentId: "33333333-3333-4333-8333-333333333333",
        connectorId: "google",
        continuation: body.continuation,
      },
    });
    expect(
      (initiation as { capabilityContinuation: { expiresAt: number } })
        .capabilityContinuation.expiresAt,
    ).toBeGreaterThan(Date.now());
  });
});
