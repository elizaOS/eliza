/**
 * Deterministic Mode A broker tests prove exact binding/token selection and
 * curated upstream tool enforcement without contacting Google.
 */
import { describe, expect, mock, test } from "bun:test";
import type { AgentConnectorExecutionBinding } from "../../db/repositories/agent-connector-bindings";
import { createGoogleMcpBroker, type GoogleMcpBrokerFetch } from "./google-mcp-broker";

function execution(): AgentConnectorExecutionBinding {
  return {
    organizationId: "org-1",
    platformCredentialId: "credential-private-1",
    credentialStatus: "active",
    binding: {
      id: "binding-1",
      agentId: "agent-1",
      provider: "google",
      role: "OWNER",
      purposes: ["automation"],
      accessGate: "owner_binding",
      status: "connected",
      oauthMode: "eliza_managed",
      executionTarget: "cloud_broker",
      selectedProducts: ["gmail", "calendar"],
      allowedCapabilities: ["gmail.read", "calendar.read"],
      grantedScopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
      ],
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

describe("Google MCP broker", () => {
  test("injects the exact binding token and filters tools/list to the curated manifest", async () => {
    const getExecutionBinding = mock(async () => execution());
    const getValidToken = mock(async () => ({ accessToken: "short-lived-token" }));
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer short-lived-token");
      expect(headers.get("x-api-key")).toBeNull();
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            { name: "search_threads", inputSchema: { type: "object" } },
            { name: "create_draft", inputSchema: { type: "object" } },
          ],
        },
      });
    });
    const broker = createGoogleMcpBroker({
      bindings: { getExecutionBinding },
      getValidToken,
      fetch: fetchMock as GoogleMcpBrokerFetch,
    });
    const response = await broker.forward({
      organizationId: "org-1",
      agentId: "agent-1",
      bindingId: "binding-1",
      product: "gmail",
      method: "POST",
      headers: new Headers({ "content-type": "application/json", "x-api-key": "cloud-key" }),
      body: new TextEncoder().encode(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      ),
    });

    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "search_threads", inputSchema: { type: "object" } }] },
    });
    expect(getValidToken).toHaveBeenCalledWith({
      organizationId: "org-1",
      connectionId: "credential-private-1",
      platform: "google",
    });
  });

  test("rejects an uncurated tool before reading the credential token", async () => {
    const getValidToken = mock(async () => ({ accessToken: "must-not-be-read" }));
    const broker = createGoogleMcpBroker({
      bindings: { getExecutionBinding: mock(async () => execution()) },
      getValidToken,
      fetch: mock() as GoogleMcpBrokerFetch,
    });
    await expect(
      broker.forward({
        organizationId: "org-1",
        agentId: "agent-1",
        bindingId: "binding-1",
        product: "gmail",
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: new TextEncoder().encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "create_draft", arguments: {} },
          }),
        ),
      }),
    ).rejects.toMatchObject({ status: 403, code: "GOOGLE_MCP_TOOL_DENIED" });
    expect(getValidToken).not.toHaveBeenCalled();
  });

  test("rejects non-tool product methods and JSON-RPC batches before token lookup", async () => {
    const getValidToken = mock(async () => ({ accessToken: "must-not-be-read" }));
    const broker = createGoogleMcpBroker({
      bindings: { getExecutionBinding: mock(async () => execution()) },
      getValidToken,
      fetch: mock() as GoogleMcpBrokerFetch,
    });
    await expect(
      broker.forward({
        organizationId: "org-1",
        agentId: "agent-1",
        bindingId: "binding-1",
        product: "gmail",
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: new TextEncoder().encode(
          JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} }),
        ),
      }),
    ).rejects.toMatchObject({ status: 403, code: "GOOGLE_MCP_METHOD_DENIED" });
    await expect(
      broker.forward({
        organizationId: "org-1",
        agentId: "agent-1",
        bindingId: "binding-1",
        product: "gmail",
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: new TextEncoder().encode(
          JSON.stringify([
            { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_draft" } },
          ]),
        ),
      }),
    ).rejects.toMatchObject({ status: 400, code: "MCP_REQUEST_INVALID" });
    expect(getValidToken).not.toHaveBeenCalled();
  });

  test("rejects modern MCP routing headers that disagree with the body", async () => {
    const getValidToken = mock(async () => ({ accessToken: "must-not-be-read" }));
    const broker = createGoogleMcpBroker({
      bindings: { getExecutionBinding: mock(async () => execution()) },
      getValidToken,
      fetch: mock() as GoogleMcpBrokerFetch,
    });
    await expect(
      broker.forward({
        organizationId: "org-1",
        agentId: "agent-1",
        bindingId: "binding-1",
        product: "gmail",
        method: "POST",
        headers: new Headers({
          "content-type": "application/json",
          "mcp-method": "tools/list",
        }),
        body: new TextEncoder().encode(
          JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {} }),
        ),
      }),
    ).rejects.toMatchObject({ status: 400, code: "MCP_REQUEST_MISMATCH" });
    expect(getValidToken).not.toHaveBeenCalled();
  });

  test("rejects legacy session HTTP methods before reading the credential token", async () => {
    const getValidToken = mock(async () => ({ accessToken: "must-not-be-read" }));
    const broker = createGoogleMcpBroker({
      bindings: { getExecutionBinding: mock(async () => execution()) },
      getValidToken,
      fetch: mock() as GoogleMcpBrokerFetch,
    });
    await expect(
      broker.forward({
        organizationId: "org-1",
        agentId: "agent-1",
        bindingId: "binding-1",
        product: "gmail",
        method: "GET",
        headers: new Headers(),
      }),
    ).rejects.toMatchObject({ status: 400, code: "MCP_METHOD_INVALID" });
    expect(getValidToken).not.toHaveBeenCalled();
  });
});
