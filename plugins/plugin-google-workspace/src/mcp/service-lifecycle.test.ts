/**
 * Integration-style lifecycle tests for the Google service's MCP host wiring.
 * The runtime registry and MCP transport are deterministic fakes; credential
 * resolution uses the service's real access-token bridge.
 */
import {
  type Action,
  type ConnectorAccount,
  getConnectorAccountManager,
  type IAgentRuntime,
  type UUID,
} from "@elizaos/core";
import type { McpRemoteResource, McpResourceEngine } from "@elizaos/plugin-mcp/resource-engine";
import { describe, expect, it, vi } from "vitest";
import { GoogleWorkspaceService } from "../service";

function runtimeHarness(): IAgentRuntime & { actions: Action[] } {
  const actions: Action[] = [];
  return {
    agentId: "10000000-0000-0000-0000-000000000001" as UUID,
    actions,
    registerAction(action: Action) {
      if (!actions.some((candidate) => candidate.name === action.name)) actions.push(action);
    },
    unregisterAction(name: string) {
      const index = actions.findIndex((candidate) => candidate.name === name);
      if (index < 0) return false;
      actions.splice(index, 1);
      return true;
    },
    getService: () => undefined,
  } as IAgentRuntime & { actions: Action[] };
}

function googleAccount(executionTarget: "agent_host" | "cloud_broker"): ConnectorAccount {
  return {
    id: `google-${executionTarget}`,
    provider: "google",
    role: "OWNER",
    purpose: ["reading"],
    accessGate: "open",
    status: "connected",
    capabilities: ["gmail.read"],
    selectedProducts: ["gmail"],
    executionTarget,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("GoogleWorkspaceService MCP lifecycle", () => {
  it("hosts local selected products with short-lived access and removes actions on stop", async () => {
    const runtime = runtimeHarness();
    let attachedResource: McpRemoteResource | undefined;
    const engine: McpResourceEngine = {
      attach: vi.fn(async (resource) => {
        attachedResource = resource;
        return { key: resource.key, generation: "generation-1" };
      }),
      detach: vi.fn(async () => true),
      discover: vi.fn(async () => ({
        server: { capabilities: { tools: {} } },
        tools: [
          {
            name: "search_threads",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
        ],
        resources: [],
        resourceTemplates: [],
      })),
      callTool: vi.fn(async () => ({ content: [] })),
    };
    const authClient = {
      credentials: { access_token: "short-lived", expiry_date: 10_000 },
      getAccessToken: vi.fn(async () => ({ token: "short-lived" })),
      setCredentials: vi.fn(),
    };
    const credentialResolver = {
      getAuthClient: vi.fn(async () => authClient),
    };
    const service = new GoogleWorkspaceService(runtime, { credentialResolver, mcpEngine: engine });

    await expect(service.connectMcpAccount(googleAccount("agent_host"))).resolves.toMatchObject({
      products: { gmail: { status: "connected" } },
    });
    expect(runtime.actions.map((action) => action.name)).toEqual(["GOOGLE_GMAIL_SEARCH_THREADS"]);
    await expect(
      attachedResource?.auth?.getAccessToken({
        key: attachedResource.key,
        endpoint: new URL(String(attachedResource.endpoint)),
        purpose: "call-tool",
      })
    ).resolves.toEqual({ accessToken: "short-lived", expiresAt: 10_000 });

    await service.stop();

    expect(runtime.actions).toEqual([]);
    expect(engine.detach).toHaveBeenCalledOnce();
  });

  it("does not export an Eliza-managed cloud binding into the local agent host", async () => {
    const runtime = runtimeHarness();
    const engine: McpResourceEngine = {
      attach: vi.fn(async () => {
        throw new Error("unexpected attach");
      }),
      detach: vi.fn(async () => false),
      discover: vi.fn(async () => {
        throw new Error("unexpected discover");
      }),
      callTool: vi.fn(async () => {
        throw new Error("unexpected call");
      }),
    };
    const service = new GoogleWorkspaceService(runtime, { mcpEngine: engine });

    await expect(service.connectMcpAccount(googleAccount("cloud_broker"))).resolves.toBeNull();
    expect(engine.attach).not.toHaveBeenCalled();
  });

  it("uses the curated Calendar MCP read behind the typed service seam", async () => {
    const runtime = runtimeHarness();
    const connectedAccount = {
      ...googleAccount("agent_host"),
      id: "google-calendar-local",
      capabilities: ["calendar.read"],
      selectedProducts: ["calendar"],
    };
    await getConnectorAccountManager(runtime).upsertAccount("google", connectedAccount);
    const callTool = vi.fn(async () => ({
      content: [],
      structuredContent: {
        events: [
          {
            id: "event-1",
            summary: "Architecture review",
            start: { dateTime: "2026-08-11T09:00:00+05:30", timeZone: "Asia/Kolkata" },
            end: { dateTime: "2026-08-11T10:00:00+05:30", timeZone: "Asia/Kolkata" },
            htmlLink: "https://calendar.google.com/event?eid=event-1",
          },
        ],
      },
    }));
    const engine: McpResourceEngine = {
      attach: vi.fn(async (resource) => ({ key: resource.key, generation: "generation-1" })),
      detach: vi.fn(async () => true),
      discover: vi.fn(async () => ({
        server: { capabilities: { tools: {} } },
        tools: [
          {
            name: "list_events",
            inputSchema: {
              type: "object",
              properties: {
                calendarId: { type: "string" },
                startTime: { type: "string" },
                endTime: { type: "string" },
              },
            },
          },
        ],
        resources: [],
        resourceTemplates: [],
      })),
      callTool,
    };
    const service = new GoogleWorkspaceService(runtime, { mcpEngine: engine });
    await service.connectMcpAccount(connectedAccount);

    await expect(
      service.listEvents({
        accountId: connectedAccount.id,
        calendarId: "primary",
        timeMin: "2026-08-11T00:00:00+05:30",
        timeMax: "2026-08-12T00:00:00+05:30",
        limit: 10,
        timeZone: "Asia/Kolkata",
      })
    ).resolves.toEqual([
      expect.objectContaining({
        id: "event-1",
        calendarId: "primary",
        title: "Architecture review",
        start: "2026-08-11T09:00:00+05:30",
        end: "2026-08-11T10:00:00+05:30",
      }),
    ]);
    expect(callTool).toHaveBeenCalledWith(expect.any(Object), {
      name: "list_events",
      arguments: {
        calendarId: "primary",
        startTime: "2026-08-11T00:00:00+05:30",
        endTime: "2026-08-12T00:00:00+05:30",
        pageSize: 10,
        timeZone: "Asia/Kolkata",
        orderBy: "startTime",
      },
    });
  });
});
