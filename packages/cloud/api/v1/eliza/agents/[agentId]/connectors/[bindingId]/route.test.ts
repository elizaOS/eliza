/**
 * Contract tests for per-agent connector revocation with deterministic auth,
 * canonical-agent resolution, and cache invalidation boundaries.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-000000000002",
}));
const findByIdInOrganization = mock();
const getAgent = mock();
const revoke = mock();
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
  agentConnectorBindingsService: { revoke },
}));
mock.module("@/lib/cache/edge-runtime-cache", () => ({
  edgeRuntimeCache: { bumpMcpVersion },
}));

const { default: route } = await import("./route");
const app = new Hono();
app.route("/api/v1/eliza/agents/:agentId/connectors/:bindingId", route);

const SANDBOX_ID = "00000000-0000-4000-8000-000000000010";
const AGENT_ID = "00000000-0000-4000-8000-000000000011";
const BINDING_ID = "00000000-0000-4000-8000-000000000012";

describe("per-agent connector revocation route", () => {
  beforeEach(() => {
    findByIdInOrganization.mockReset();
    getAgent.mockReset();
    revoke.mockReset();
    bumpMcpVersion.mockReset();
    bumpMcpVersion.mockResolvedValue(1);
  });

  test("revokes only the requested binding under its canonical agent", async () => {
    findByIdInOrganization.mockImplementation(async (id: string) =>
      id === AGENT_ID ? { id: AGENT_ID } : null,
    );
    getAgent.mockResolvedValue({ id: SANDBOX_ID, character_id: AGENT_ID });
    revoke.mockResolvedValue(undefined);

    const response = await app.request(
      `/api/v1/eliza/agents/${SANDBOX_ID}/connectors/${BINDING_ID}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(204);
    expect(revoke).toHaveBeenCalledWith({
      organizationId: "00000000-0000-4000-8000-000000000002",
      agentId: AGENT_ID,
      bindingId: BINDING_ID,
    });
    expect(bumpMcpVersion).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000002",
    );
  });

  test("does not invalidate runtime config when the scoped binding is absent", async () => {
    findByIdInOrganization.mockResolvedValue({ id: AGENT_ID });
    revoke.mockRejectedValue(
      new ApiError(
        404,
        "CONNECTOR_BINDING_NOT_FOUND",
        "Connector binding not found.",
      ),
    );

    const response = await app.request(
      `/api/v1/eliza/agents/${AGENT_ID}/connectors/${BINDING_ID}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(404);
    const payload: unknown = await response.json();
    expect(payload).toEqual({
      success: false,
      error: "Connector binding not found.",
      code: "CONNECTOR_BINDING_NOT_FOUND",
    });
    expect(bumpMcpVersion).not.toHaveBeenCalled();
  });
});
