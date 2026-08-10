/**
 * Validates the Cloud MCP client's trusted-origin and external-resource
 * boundary without opening a transport. Private destinations and serialized
 * bearer material must fail before DNS or connection setup.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { UUID } from "@elizaos/core";
import type { AgentConnectorExecutionBinding } from "../../db/repositories/agent-connector-bindings";
import {
  createDirectConnectorFetch,
  type DirectConnectorFetchDependencies,
  validateCloudMcpHttpConfig,
} from "./service";

const previousAppUrl = process.env.APP_URL;
const previousPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL;

const GOOGLE_GMAIL_CONFIG = {
  type: "streamable-http" as const,
  url: "https://gmailmcp.googleapis.com/mcp/v1",
  connectorBindingId: "binding-id",
  connectorAgentId: "agent-id",
  connectorOrganizationId: "organization-id",
  allowedTools: ["search_threads"],
};

function executionBinding(
  binding: Partial<AgentConnectorExecutionBinding["binding"]> = {},
): AgentConnectorExecutionBinding {
  return {
    organizationId: "organization-id",
    platformCredentialId: "credential-id",
    credentialStatus: "active",
    binding: {
      id: "binding-id",
      agentId: "00000000-0000-4000-8000-000000000001" as UUID,
      provider: "google",
      role: "OWNER",
      purposes: ["automation"],
      accessGate: "owner_binding",
      status: "connected",
      selectedProducts: ["gmail"],
      allowedCapabilities: ["gmail.read"],
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
      ...binding,
    },
  };
}

function directFetchHarness(execution: AgentConnectorExecutionBinding) {
  const getExecutionBinding = mock(async () => execution);
  const getValidToken = mock(async () => ({
    accessToken: "short-lived-access-token",
    refreshed: false,
    fromCache: false,
  }));
  const fetch = mock(async () => new Response(null, { status: 204 }));
  const dependencies: DirectConnectorFetchDependencies = {
    getExecutionBinding,
    getValidToken,
    fetch,
  };
  return {
    fetchConnector: createDirectConnectorFetch(GOOGLE_GMAIL_CONFIG, dependencies),
    getExecutionBinding,
    getValidToken,
    fetch,
  };
}

const SEARCH_THREADS_CALL: RequestInit = {
  method: "POST",
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "search_threads", arguments: { query: "is:unread" } },
  }),
};

afterEach(() => {
  if (previousAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = previousAppUrl;
  if (previousPublicAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = previousPublicAppUrl;
});

describe("Cloud MCP remote config security", () => {
  test("allows a connector-bound official Google resource with complete private context", async () => {
    await expect(
      validateCloudMcpHttpConfig("google-gmail-binding", {
        type: "streamable-http",
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        connectorBindingId: "binding-id",
        connectorAgentId: "agent-id",
        connectorOrganizationId: "organization-id",
        allowedTools: ["search_threads"],
      }),
    ).resolves.toBeUndefined();
  });

  test("rechecks the current product, canonical capability, and scopes before bearer injection", async () => {
    const authorized = directFetchHarness(executionBinding());
    const response = await authorized.fetchConnector(GOOGLE_GMAIL_CONFIG.url, SEARCH_THREADS_CALL);
    expect(response.status).toBe(204);
    expect(authorized.getValidToken).toHaveBeenCalledTimes(1);
    const forwarded = authorized.fetch.mock.calls[0]?.[1];
    expect(new Headers(forwarded?.headers).get("authorization")).toBe(
      "Bearer short-lived-access-token",
    );

    const narrowedCases: Array<{
      name: string;
      execution: AgentConnectorExecutionBinding;
      config?: typeof GOOGLE_GMAIL_CONFIG;
      expected: string;
    }> = [
      {
        name: "product removed",
        execution: executionBinding({ selectedProducts: ["calendar"] }),
        expected: "no longer selected",
      },
      {
        name: "capability removed",
        execution: executionBinding({ allowedCapabilities: [] }),
        expected: "no currently authorized tool",
      },
      {
        name: "scope removed",
        execution: executionBinding({ grantedScopes: [] }),
        expected: "no currently authorized tool",
      },
      {
        name: "cached allowlist claims a noncanonical Gmail tool",
        execution: executionBinding({
          allowedCapabilities: ["chat.send"],
          grantedScopes: ["https://www.googleapis.com/auth/chat.messages"],
        }),
        config: { ...GOOGLE_GMAIL_CONFIG, allowedTools: ["send_message"] },
        expected: "no currently authorized tool",
      },
    ];

    for (const narrowed of narrowedCases) {
      const harness = directFetchHarness(narrowed.execution);
      const config = narrowed.config ?? GOOGLE_GMAIL_CONFIG;
      const fetchConnector = createDirectConnectorFetch(config, {
        getExecutionBinding: harness.getExecutionBinding,
        getValidToken: harness.getValidToken,
        fetch: harness.fetch,
      });
      const request = narrowed.config
        ? {
            ...SEARCH_THREADS_CALL,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "send_message", arguments: {} },
            }),
          }
        : SEARCH_THREADS_CALL;
      await expect(fetchConnector(config.url, request), narrowed.name).rejects.toThrow(
        narrowed.expected,
      );
      expect(harness.getValidToken, narrowed.name).not.toHaveBeenCalled();
      expect(harness.fetch, narrowed.name).not.toHaveBeenCalled();
    }
  });

  test("rejects a different official product endpoint before looking up or projecting a token", async () => {
    const harness = directFetchHarness(executionBinding());
    await expect(
      harness.fetchConnector("https://calendarmcp.googleapis.com/mcp/v1", SEARCH_THREADS_CALL),
    ).rejects.toThrow("unapproved resource URL");
    expect(harness.getExecutionBinding).not.toHaveBeenCalled();
    expect(harness.getValidToken).not.toHaveBeenCalled();
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  test("derives the tool from the JSON-RPC call and rejects spoofed or uninspectable requests", async () => {
    const cases: Array<{
      name: string;
      request: RequestInit;
      expected: string;
      bindingLookups: number;
    }> = [
      {
        name: "spoofed tool header",
        request: {
          method: "POST",
          headers: { "mcp-name": "search_threads" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "send_message", arguments: {} },
          }),
        },
        expected: "outside the connector binding allowlist",
        bindingLookups: 1,
      },
      {
        name: "uninspectable tool call",
        request: { method: "POST", body: new Uint8Array([1, 2, 3]) },
        expected: "cannot be authorized",
        bindingLookups: 0,
      },
      {
        name: "non-tool capability family",
        request: {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list" }),
        },
        expected: "request method is not allowed",
        bindingLookups: 0,
      },
    ];

    for (const testCase of cases) {
      const harness = directFetchHarness(executionBinding());
      await expect(
        harness.fetchConnector(GOOGLE_GMAIL_CONFIG.url, testCase.request),
        testCase.name,
      ).rejects.toThrow(testCase.expected);
      expect(harness.getExecutionBinding, testCase.name).toHaveBeenCalledTimes(
        testCase.bindingLookups,
      );
      expect(harness.getValidToken, testCase.name).not.toHaveBeenCalled();
      expect(harness.fetch, testCase.name).not.toHaveBeenCalled();
    }
  });

  test("rejects incomplete connector context and non-catalogued Google API hosts", async () => {
    await expect(
      validateCloudMcpHttpConfig("missing-tenant", {
        type: "streamable-http",
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        connectorBindingId: "binding-id",
        allowedTools: ["search_threads"],
      }),
    ).rejects.toThrow("missing binding context");

    await expect(
      validateCloudMcpHttpConfig("generic-google-api", {
        type: "streamable-http",
        url: "https://storage.googleapis.com/mcp/v1",
        connectorBindingId: "binding-id",
        connectorAgentId: "agent-id",
        connectorOrganizationId: "organization-id",
        allowedTools: ["search_threads"],
      }),
    ).rejects.toThrow("catalogued Google endpoint");
  });

  test("requires an explicit curated tool allowlist for connector resources", async () => {
    await expect(
      validateCloudMcpHttpConfig("unbounded-google", {
        type: "streamable-http",
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        connectorBindingId: "binding-id",
        connectorAgentId: "agent-id",
        connectorOrganizationId: "organization-id",
      }),
    ).rejects.toThrow("non-empty tool allowlist");
  });

  test("rejects private external destinations and serialized authorization", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://cloud.eliza.test";
    await expect(
      validateCloudMcpHttpConfig("metadata", {
        type: "streamable-http",
        url: "http://169.254.169.254/latest/meta-data",
      }),
    ).rejects.toThrow("Unsafe MCP server metadata");
    await expect(
      validateCloudMcpHttpConfig("raw-token", {
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer raw-token" },
      }),
    ).rejects.toThrow("may not receive serialized credentials");
  });
});
