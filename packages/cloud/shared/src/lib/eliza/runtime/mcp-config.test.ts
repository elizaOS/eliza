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
    selectedProducts: ["gmail", "calendar", "drive"],
    allowedCapabilities: ["gmail.read", "calendar.read"],
    grantedScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ],
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("connector-aware Cloud MCP config", () => {
  test("fans one Google binding into curated official per-product resources", () => {
    const userContext = context(binding());
    expect(getConnectedMcpPlatforms(userContext)).toEqual([
      "google-gmail-binding-1",
      "google-calendar-binding-1",
    ]);
    expect(buildMcpSettings(userContext)).toEqual({
      mcp: {
        servers: {
          "google-gmail-binding-1": {
            type: "streamable-http",
            url: "https://gmailmcp.googleapis.com/mcp/v1",
            connectorBindingId: "binding-1",
            connectorAgentId: "agent-1",
            connectorOrganizationId: "org-1",
            allowedTools: ["get_thread", "get_message", "search_threads"],
          },
          "google-calendar-binding-1": {
            type: "streamable-http",
            url: "https://calendarmcp.googleapis.com/mcp/v1",
            connectorBindingId: "binding-1",
            connectorAgentId: "agent-1",
            connectorOrganizationId: "org-1",
            allowedTools: ["list_events"],
          },
        },
      },
    });
  });

  test("never exports disconnected bindings into Cloud runtime config", () => {
    expect(buildMcpSettings(context(binding({ status: "disabled" })))).toEqual({});
  });

  test.each([
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar",
  ])("keeps legacy %s grants usable only for curated Calendar reads", (scope) => {
    const settings = buildMcpSettings(
      context(
        binding({
          selectedProducts: ["calendar"],
          allowedCapabilities: ["calendar.read"],
          grantedScopes: [scope],
        }),
      ),
    ) as { mcp: { servers: Record<string, { allowedTools: string[] }> } };

    expect(settings.mcp.servers["google-calendar-binding-1"]?.allowedTools).toEqual([
      "list_events",
    ]);
  });

  test("normalizes the workspace capability prefix to Google's universal search resource", () => {
    const settings = buildMcpSettings(
      context(
        binding({
          selectedProducts: ["workspace"],
          allowedCapabilities: ["workspace.search"],
        }),
      ),
    ) as { mcp: { servers: Record<string, Record<string, unknown>> } };

    expect(settings.mcp.servers["google-universalSearch-binding-1"]).toEqual(
      expect.objectContaining({
        url: "https://workspacemcp.googleapis.com/mcp/v1",
        allowedTools: ["search_corpus"],
      }),
    );
  });

  test("keeps account-specific namespaces and orders the default binding first", () => {
    const userContext = context(binding({ id: "binding-secondary", isDefault: false }));
    userContext.connectorBindings?.push(binding({ id: "binding-primary", isDefault: true }));
    const settings = buildMcpSettings(userContext) as {
      mcp: { servers: Record<string, { url: string }> };
    };
    expect(Object.keys(settings.mcp.servers)).toEqual([
      "google-gmail-binding-primary",
      "google-calendar-binding-primary",
      "google-gmail-binding-secondary",
      "google-calendar-binding-secondary",
    ]);
    expect(settings.mcp.servers["google-gmail-binding-primary"].url).toBe(
      "https://gmailmcp.googleapis.com/mcp/v1",
    );
  });
});
