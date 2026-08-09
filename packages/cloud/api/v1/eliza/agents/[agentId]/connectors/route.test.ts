/**
 * Contract tests for the agent connector route with deterministic auth,
 * canonical-agent resolution, and service boundaries.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-000000000002",
}));
const findByIdInOrganization = mock();
const getAgent = mock();
const bind = mock();
const list = mock();
const bumpMcpVersion = mock(async () => 1);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: { findByIdInOrganization },
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { getAgent },
}));
mock.module("@/lib/services/agent-connector-bindings", () => ({
  AgentConnectorBindingError: class extends Error {},
  agentConnectorBindingsService: { bind, list },
}));
mock.module("@/lib/cache/edge-runtime-cache", () => ({
  edgeRuntimeCache: { bumpMcpVersion },
}));

const { default: route } = await import("./route");
const app = new Hono();
app.route("/api/v1/eliza/agents/:agentId/connectors", route);

const SANDBOX_ID = "00000000-0000-4000-8000-000000000010";
const AGENT_ID = "00000000-0000-4000-8000-000000000011";
const CREDENTIAL_ID = "00000000-0000-4000-8000-000000000012";

function publicBinding() {
  return {
    id: "00000000-0000-4000-8000-000000000013",
    agentId: AGENT_ID,
    provider: "google",
    role: "OWNER",
    purposes: ["automation"],
    accessGate: "owner_binding",
    status: "connected",
    oauthMode: "eliza_managed",
    executionTarget: "cloud_broker",
    selectedProducts: ["gmail", "calendar"],
    allowedCapabilities: ["gmail.read", "calendar.read"],
    grantedScopes: ["scope-a"],
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("agent connector bindings route", () => {
  beforeEach(() => {
    findByIdInOrganization.mockReset();
    getAgent.mockReset();
    bind.mockReset();
    list.mockReset();
  });

  test("canonicalizes a sandbox ID and never returns the private credential locator", async () => {
    findByIdInOrganization.mockImplementation(async (id: string) =>
      id === AGENT_ID ? { id: AGENT_ID } : null,
    );
    getAgent.mockResolvedValue({ id: SANDBOX_ID, character_id: AGENT_ID });
    bind.mockResolvedValue(publicBinding());

    const response = await app.request(
      `/api/v1/eliza/agents/${SANDBOX_ID}/connectors`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platformCredentialId: CREDENTIAL_ID,
          provider: "google",
          role: "OWNER",
          oauthMode: "eliza_managed",
          executionTarget: "cloud_broker",
          selectedProducts: ["gmail", "calendar"],
          allowedCapabilities: ["gmail.read", "calendar.read"],
          isDefault: true,
        }),
      },
    );

    expect(response.status).toBe(201);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.agentId).toBe(AGENT_ID);
    expect(JSON.stringify(payload)).not.toContain(CREDENTIAL_ID);
    expect(bind).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT_ID,
        platformCredentialId: CREDENTIAL_ID,
        authorizedByUserId: "00000000-0000-4000-8000-000000000001",
      }),
    );
  });

  test("rejects an agent outside the caller's organization before binding", async () => {
    findByIdInOrganization.mockResolvedValue(null);
    getAgent.mockResolvedValue(null);
    const response = await app.request(
      `/api/v1/eliza/agents/${SANDBOX_ID}/connectors`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platformCredentialId: CREDENTIAL_ID,
          provider: "google",
          role: "OWNER",
          oauthMode: "eliza_managed",
          executionTarget: "cloud_broker",
          selectedProducts: ["gmail"],
          allowedCapabilities: ["gmail.read"],
        }),
      },
    );
    expect(response.status).toBe(404);
    expect(bind).not.toHaveBeenCalled();
  });
});
