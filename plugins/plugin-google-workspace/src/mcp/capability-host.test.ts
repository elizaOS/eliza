/**
 * Deterministic contract tests for Google MCP resource attachment and curated
 * dynamic action ownership. The remote MCP engine and runtime registry are
 * fakes; exact tool routing and connect/disconnect behavior are real.
 */
import type { Action, ConnectorAccount, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import type {
  McpAttachmentRef,
  McpDiscovery,
  McpResourceEngine,
} from "@elizaos/plugin-mcp/resource-engine";
import { describe, expect, it, vi } from "vitest";
import { GoogleMcpCapabilityHost } from "./capability-host";

function discovery(tools: McpDiscovery["tools"]): McpDiscovery {
  return {
    server: { info: { name: "google", version: "preview" }, capabilities: { tools: {} } },
    tools,
    resources: [],
    resourceTemplates: [],
  };
}

function account(): ConnectorAccount {
  return {
    id: "acct-google-1",
    provider: "google",
    label: "Owner Google",
    role: "OWNER",
    purpose: ["reading", "automation"],
    accessGate: "open",
    status: "connected",
    capabilities: ["gmail.read", "calendar.read"],
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
    selectedProducts: ["gmail", "calendar"],
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

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

function engineHarness(): McpResourceEngine & {
  callTool: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
} {
  let generation = 0;
  const refs = new Map<string, McpAttachmentRef>();
  const attach = vi.fn(async ({ key }: { key: string }) => {
    const ref = { key, generation: String(++generation) };
    refs.set(key, ref);
    return ref;
  });
  const discover = vi.fn(async (ref: McpAttachmentRef) => {
    if (ref.key.endsWith(":gmail")) {
      return discovery([
        {
          name: "search_threads",
          description: "Search Gmail threads",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" }, pageSize: { type: "integer" } },
          },
        },
        {
          name: "unexpected_preview_tool",
          inputSchema: { type: "object" },
        },
      ]);
    }
    return discovery([
      {
        name: "list_events",
        description: "List calendar events",
        inputSchema: {
          type: "object",
          properties: {
            calendarId: { type: "string" },
            startTime: { type: "string" },
            endTime: { type: "string" },
          },
        },
      },
    ]);
  });
  const callTool = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "result" }],
    structuredContent: { threads: [{ id: "thread-1" }] },
  }));
  const detach = vi.fn(async (ref: McpAttachmentRef) => refs.delete(ref.key));
  return { attach, discover, callTool, detach };
}

describe("GoogleMcpCapabilityHost", () => {
  it("materializes only curated discovered actions and removes them on disconnect", async () => {
    const runtime = runtimeHarness();
    const engine = engineHarness();
    const host = new GoogleMcpCapabilityHost(runtime, {
      engine,
      accessTokenProviderFor: () => ({
        getAccessToken: async () => ({ accessToken: "access-token" }),
      }),
      authorizeAccount: async () => true,
    });

    const report = await host.connectAccount(account());

    expect(report.products).toMatchObject({
      gmail: { status: "connected", promotedActions: ["GOOGLE_GMAIL_SEARCH_THREADS"] },
      calendar: { status: "connected", promotedActions: ["GOOGLE_CALENDAR_LIST_EVENTS"] },
    });
    expect(runtime.actions.map((action) => action.name).sort()).toEqual([
      "GOOGLE_CALENDAR_LIST_EVENTS",
      "GOOGLE_GMAIL_SEARCH_THREADS",
    ]);
    expect(runtime.actions.some((action) => action.name.includes("UNEXPECTED"))).toBe(false);

    const gmailAction = runtime.actions.find(
      (action) => action.name === "GOOGLE_GMAIL_SEARCH_THREADS"
    );
    expect(gmailAction?.connectorAccountPolicy).toMatchObject({
      provider: "google",
      requiredCapabilities: ["gmail.read"],
    });
    await expect(
      gmailAction?.handler(
        runtime,
        { id: "message-1" as UUID, content: { text: "search" } } as Memory,
        undefined,
        { parameters: { accountId: "acct-google-1", query: "from:alice@example.com" } }
      )
    ).resolves.toMatchObject({ success: true });
    expect(engine.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringMatching(/:gmail$/) }),
      {
        name: "search_threads",
        arguments: { query: "from:alice@example.com" },
      }
    );

    await host.disconnectAccount("acct-google-1");

    expect(runtime.actions).toEqual([]);
    expect(engine.detach).toHaveBeenCalledTimes(2);
  });

  it("keeps a successful product active when a sibling product discovery fails", async () => {
    const runtime = runtimeHarness();
    const engine = engineHarness();
    vi.mocked(engine.discover).mockImplementation(async (ref) => {
      if (ref.key.endsWith(":calendar")) throw new Error("calendar preview unavailable");
      return discovery([
        {
          name: "search_threads",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ]);
    });
    const host = new GoogleMcpCapabilityHost(runtime, {
      engine,
      accessTokenProviderFor: () => ({
        getAccessToken: async () => ({ accessToken: "access-token" }),
      }),
      authorizeAccount: async () => true,
    });

    const report = await host.connectAccount(account());

    expect(report.products.gmail?.status).toBe("connected");
    expect(report.products.calendar).toMatchObject({
      status: "error",
      error: "calendar preview unavailable",
    });
    expect(runtime.actions.map((action) => action.name)).toEqual(["GOOGLE_GMAIL_SEARCH_THREADS"]);
    expect(engine.detach).toHaveBeenCalledTimes(1);
  });

  it("detaches products removed by a narrower reconnect", async () => {
    const runtime = runtimeHarness();
    const engine = engineHarness();
    const host = new GoogleMcpCapabilityHost(runtime, {
      engine,
      accessTokenProviderFor: () => ({
        getAccessToken: async () => ({ accessToken: "access-token" }),
      }),
      authorizeAccount: async () => true,
    });

    await host.connectAccount(account());
    await host.connectAccount({
      ...account(),
      selectedProducts: ["gmail"],
      capabilities: ["gmail.read"],
    });

    expect(runtime.actions.map((action) => action.name)).toEqual(["GOOGLE_GMAIL_SEARCH_THREADS"]);
    expect(engine.detach).toHaveBeenCalledTimes(2);
    await expect(
      host.callTool({
        accountId: "acct-google-1",
        product: "calendar",
        toolName: "list_events",
      })
    ).rejects.toMatchObject({ code: "GOOGLE_MCP_CAPABILITY_UNAVAILABLE" });
  });

  it("never unregisters an incumbent action after a normalized name collision", async () => {
    const runtime = runtimeHarness();
    const incumbent: Action = {
      name: "GOOGLE_GMAIL_SEARCH_THREADS",
      description: "incumbent",
      validate: async () => true,
      handler: async () => ({ success: true }),
    };
    runtime.actions.push(incumbent);
    const engine = engineHarness();
    const host = new GoogleMcpCapabilityHost(runtime, {
      engine,
      accessTokenProviderFor: () => ({
        getAccessToken: async () => ({ accessToken: "access-token" }),
      }),
      authorizeAccount: async () => true,
    });

    await host.connectAccount({
      ...account(),
      selectedProducts: ["gmail"],
      capabilities: ["gmail.read"],
    });
    await host.disconnectAccount("acct-google-1");

    expect(runtime.actions).toEqual([incumbent]);
  });
});
