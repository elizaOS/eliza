/**
 * Tests the hosted runtime's connector-aware MCP config projection without
 * opening transports or exposing credential locators.
 */

import { describe, expect, test } from "bun:test";
import type { AgentConnectorBinding } from "@elizaos/core";
import type { UserContext } from "../user-context";
import { buildMcpSettings, getConnectedMcpPlatforms } from "./mcp-config";

function context(binding: AgentConnectorBinding): UserContext {
  return {
    userId: "user-1",
    entityId: "user-1",
    organizationId: "org-1",
    agentMode: "CHAT" as UserContext["agentMode"],
    apiKey: "redacted",
    isAnonymous: false,
    characterId: "agent-1",
    connectorBindings: [binding],
  };
}

function binding(overrides: Partial<AgentConnectorBinding> = {}): AgentConnectorBinding {
  return {
    id: "binding-1",
    agentId: "agent-1",
    provider: "google",
    role: "OWNER",
    purposes: ["automation"],
    accessGate: "owner_binding",
    status: "connected",
    oauthMode: "eliza_managed",
    executionTarget: "cloud_broker",
    selectedProducts: ["gmail", "calendar", "drive"],
    allowedCapabilities: ["gmail.read", "calendar.read"],
    grantedScopes: [],
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("connector-aware Cloud MCP config", () => {
  test("fans one Google binding into curated per-product broker endpoints", () => {
    const userContext = context(binding());
    expect(getConnectedMcpPlatforms(userContext)).toEqual(["google-gmail", "google-calendar"]);
    expect(buildMcpSettings(userContext)).toEqual({
      mcp: {
        servers: {
          "google-gmail": {
            type: "streamable-http",
            url: "http://localhost:3000/api/v1/eliza/agents/agent-1/connectors/binding-1/mcp/gmail",
          },
          "google-calendar": {
            type: "streamable-http",
            url: "http://localhost:3000/api/v1/eliza/agents/agent-1/connectors/binding-1/mcp/calendar",
          },
        },
      },
    });
  });

  test("never exports agent-host or disconnected bindings into Cloud runtime config", () => {
    expect(buildMcpSettings(context(binding({ executionTarget: "agent_host" })))).toEqual({});
    expect(buildMcpSettings(context(binding({ status: "disabled" })))).toEqual({});
  });

  test("keeps stable action namespaces and routes each product through the default binding", () => {
    const userContext = context(binding({ id: "binding-secondary", isDefault: false }));
    userContext.connectorBindings?.push(binding({ id: "binding-primary", isDefault: true }));
    const settings = buildMcpSettings(userContext) as {
      mcp: { servers: Record<string, { url: string }> };
    };
    expect(Object.keys(settings.mcp.servers)).toEqual(["google-gmail", "google-calendar"]);
    expect(settings.mcp.servers["google-gmail"].url).toContain(
      "/connectors/binding-primary/mcp/gmail",
    );
  });
});
