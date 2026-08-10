/**
 * Contract tests for generic OAuth initiation with an atomic agent connector
 * binding request. Provider and auth boundaries are deterministic; no network
 * or credential storage is used.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-000000000002",
}));
const findByIdInOrganization = mock();
const getAgent = mock();
const initiateOAuth2 = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: { findByIdInOrganization },
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { getAgent },
}));
mock.module("@/lib/services/oauth/provider-registry", () => ({
  getProvider: () => ({
    id: "google",
    name: "Google",
    type: "oauth2",
    useGenericRoutes: true,
    defaultScopes: [],
    envVars: [],
  }),
  isProviderConfigured: () => true,
  getCallbackUrl: () => "https://test.example/callback",
  resolveRequestedScopes: (_provider: unknown, scopes?: string[]) =>
    scopes ?? [],
  resolveOAuthClientCredentials: async () => ({
    clientId: "client-id",
    clientSecret: "client-secret",
  }),
  getNestedValue: () => undefined,
}));
mock.module("@/lib/services/oauth/providers", () => ({ initiateOAuth2 }));
mock.module("@/lib/services/oauth", () => ({
  OAuthError: class OAuthError extends Error {
    httpStatus = 400;
    toResponse() {
      return { error: this.message };
    }
  },
}));

const { handleGenericOAuthInitiate } = await import("./generic-initiate");
const app = new Hono();
app.post("/api/v1/oauth/:platform/initiate", (c) =>
  handleGenericOAuthInitiate(c as never, c.req.param("platform")),
);

const AGENT_ID = "00000000-0000-4000-8000-000000000003";

describe("generic OAuth agent binding initiation", () => {
  beforeEach(() => {
    findByIdInOrganization.mockReset();
    getAgent.mockReset();
    initiateOAuth2.mockReset();
  });

  test("persists a server-validated binding request in OAuth state", async () => {
    findByIdInOrganization.mockResolvedValue({ id: AGENT_ID });
    initiateOAuth2.mockResolvedValue({
      authUrl: "https://accounts.google.test/auth",
      state: "s",
    });

    const response = await app.request("/api/v1/oauth/google/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        connectionRole: "owner",
        agentBinding: {
          agentId: AGENT_ID,
          role: "OWNER",
          selectedProducts: ["gmail"],
          isDefault: true,
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(findByIdInOrganization).toHaveBeenCalledWith(
      AGENT_ID,
      "00000000-0000-4000-8000-000000000002",
    );
    expect(initiateOAuth2).toHaveBeenCalledWith(
      expect.objectContaining({ id: "google" }),
      expect.objectContaining({
        organizationId: "00000000-0000-4000-8000-000000000002",
        userId: "00000000-0000-4000-8000-000000000001",
        connectionRole: "OWNER",
        agentBinding: {
          agentId: AGENT_ID,
          role: "OWNER",
          selectedProducts: ["gmail"],
          isDefault: true,
        },
      }),
    );
  });

  test("keeps a Google credential owner-scoped when the agent binding role differs", async () => {
    findByIdInOrganization.mockResolvedValue({ id: AGENT_ID });
    initiateOAuth2.mockResolvedValue({
      authUrl: "https://accounts.google.test/auth",
      state: "s",
    });

    const response = await app.request("/api/v1/oauth/google/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionRole: "agent",
        agentBinding: {
          agentId: AGENT_ID,
          role: "AGENT",
          selectedProducts: ["gmail", "calendar"],
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(initiateOAuth2).toHaveBeenCalledWith(
      expect.objectContaining({ id: "google" }),
      expect.objectContaining({
        connectionRole: "OWNER",
        agentBinding: {
          agentId: AGENT_ID,
          role: "AGENT",
          selectedProducts: ["gmail", "calendar"],
        },
      }),
    );
  });

  test("rejects an agent outside the caller organization before creating OAuth state", async () => {
    findByIdInOrganization.mockResolvedValue(null);
    getAgent.mockResolvedValue(null);
    const response = await app.request("/api/v1/oauth/google/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentBinding: {
          agentId: AGENT_ID,
          role: "OWNER",
          selectedProducts: ["gmail"],
        },
      }),
    });

    expect(response.status).toBe(404);
    expect(initiateOAuth2).not.toHaveBeenCalled();
  });
});
