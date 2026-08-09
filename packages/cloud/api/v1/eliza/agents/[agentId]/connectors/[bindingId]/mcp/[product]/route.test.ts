/**
 * Contract tests for the binding-scoped Google MCP transport route. The Hono
 * boundary is real; authentication, canonical-agent lookup, and broker I/O are
 * deterministic mocks so request size and private-routing behavior are fixed.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-000000000002",
}));
const findByIdInOrganization = mock();
const getAgent = mock();
const forward = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: { findByIdInOrganization },
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { getAgent },
}));
mock.module("@/lib/services/google-mcp-broker", () => ({
  GoogleMcpBrokerError: class extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  googleMcpBroker: { forward },
}));

const { default: route } = await import("./route");
const app = new Hono();
app.route(
  "/api/v1/eliza/agents/:agentId/connectors/:bindingId/mcp/:product",
  route,
);

const SANDBOX_ID = "00000000-0000-4000-8000-000000000010";
const AGENT_ID = "00000000-0000-4000-8000-000000000011";
const BINDING_ID = "00000000-0000-4000-8000-000000000012";

describe("Google connector MCP route", () => {
  beforeEach(() => {
    findByIdInOrganization.mockReset();
    getAgent.mockReset();
    forward.mockReset();
  });

  test("canonicalizes the agent and delegates only binding-scoped request data", async () => {
    findByIdInOrganization.mockImplementation(async (id: string) =>
      id === AGENT_ID ? { id: AGENT_ID } : null,
    );
    getAgent.mockResolvedValue({ id: SANDBOX_ID, character_id: AGENT_ID });
    forward.mockResolvedValue(
      Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    );
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const response = await app.request(
      `/api/v1/eliza/agents/${SANDBOX_ID}/connectors/${BINDING_ID}/mcp/gmail`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "agent-key",
        },
        body,
      },
    );

    expect(response.status).toBe(200);
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "00000000-0000-4000-8000-000000000002",
        agentId: AGENT_ID,
        bindingId: BINDING_ID,
        product: "gmail",
        method: "POST",
      }),
    );
    const request = forward.mock.calls[0]?.[0] as {
      body?: Uint8Array;
      headers: Headers;
    };
    expect(new TextDecoder().decode(request.body)).toBe(body);
    expect(request.headers.get("x-api-key")).toBe("agent-key");
  });

  test("rejects oversized requests before broker execution", async () => {
    findByIdInOrganization.mockResolvedValue({ id: AGENT_ID });
    const response = await app.request(
      `/api/v1/eliza/agents/${AGENT_ID}/connectors/${BINDING_ID}/mcp/calendar`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(1024 * 1024 + 1),
        },
        body: "{}",
      },
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({
      error: "MCP request is too large.",
      code: "MCP_REQUEST_TOO_LARGE",
    });
    expect(forward).not.toHaveBeenCalled();
  });
});
