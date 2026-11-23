/**
 * Nested MCP tool arguments at the cloud planner boundary.
 *
 * The cloud native planner hands every tool call to executePlannedToolCall,
 * which validates the arguments against the action parameters that
 * convertJsonSchemaToActionParams built from the tool's inputSchema. Only then
 * does the action handler send them to the MCP server. The server here is a
 * real MCP SDK server that validates its own zod schemas.
 */
import {
  type Action,
  ChannelType,
  type Content,
  executePlannedToolCall,
  type IAgentRuntime,
  type Memory,
  Service,
  type State,
  type UUID,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpToolAction } from "./dynamic-tool-actions";

type Arguments = Record<string, unknown>;

// Shapes of real servers: server-github push_files, Any and dict[str, str].
async function connectServer() {
  const delivered: unknown[] = [];
  const server = new McpServer({ name: "nested-shape-server", version: "1.0.0" });
  const record = async (args: unknown) => {
    delivered.push(args);
    return { content: [{ type: "text" as const, text: "ok" }] };
  };
  server.registerTool(
    "push_files",
    {
      inputSchema: {
        branch: z.string(),
        files: z.array(z.object({ path: z.string(), content: z.string() })),
      },
    },
    record,
  );
  server.registerTool("echo_value", { inputSchema: { value: z.any() } }, record);
  server.registerTool(
    "set_labels",
    { inputSchema: { labels: z.record(z.string(), z.string()) } },
    record,
  );
  const client = new Client({ name: "nested-shape-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  return { client, server, tools, delivered };
}

async function plan(tool: string, args: Arguments) {
  const { client, server, tools, delivered } = await connectServer();
  // Whether the server itself accepts the arguments, without the planner.
  const direct = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
  const serverAccepts = direct.isError !== true && delivered.length === 1;
  delivered.length = 0;

  const dispatched: string[] = [];
  class ConnectedMcpService extends Service {
    static serviceType = "mcp";
    capabilityDescription = "MCP tools of one connected server";
    static async start(runtime: IAgentRuntime) {
      return new ConnectedMcpService(runtime);
    }
    async stop() {}
    isLazyConnection() {
      return false;
    }
    getServers() {
      return [{ name: "peer", status: "connected", tools }];
    }
    async callTool(_server: string, toolName: string, params: Arguments) {
      dispatched.push(toolName);
      return (await client.callTool({ name: toolName, arguments: params })) as CallToolResult;
    }
  }
  const ownerId = crypto.randomUUID() as UUID;
  const worldId = crypto.randomUUID() as UUID;
  const roomId = crypto.randomUUID() as UUID;
  const runtime = createSQLiteTestRuntime({
    character: {
      name: "NestedArgumentsAgent",
      bio: ["MCP argument test agent"],
      settings: { ELIZA_ADMIN_ENTITY_ID: ownerId },
    },
    plugins: [{ name: "connected-mcp", description: "MCP", services: [ConnectedMcpService] }],
    logLevel: "fatal",
  });
  try {
    await runtime.initialize();
    await runtime.getServiceLoadPromise("mcp");
    // MCP tool actions need ADMIN: the caller owns the world of the chat.
    await runtime.createWorld({
      id: worldId,
      name: "Cloud workspace",
      agentId: runtime.agentId,
      metadata: { ownership: { ownerId } },
    });
    await runtime.createRoom({
      id: roomId,
      name: "Cloud chat",
      source: "cloud",
      type: ChannelType.DM,
      worldId,
    });
    // As the cloud MCP service registers its tool actions (service.ts).
    const names = new Set<string>();
    const actions = tools.map((entry) => {
      const action = createMcpToolAction("peer", entry, names);
      names.add(action.name);
      runtime.registerAction(action as Action);
      return action;
    });
    const action = actions[tools.findIndex((entry) => entry.name === tool)];
    const message: Memory = {
      id: crypto.randomUUID() as UUID,
      entityId: ownerId,
      roomId,
      content: { text: `run ${tool}`, params: args } as Content,
    };
    const state = { values: {}, data: { actionParams: args }, text: "" } as State;
    const result = await executePlannedToolCall(
      runtime,
      { message, state, activeContexts: ["connectors"], previousResults: [] },
      { name: action.name, params: args },
    );
    return { result, serverAccepts, dispatched, delivered };
  } finally {
    await runtime.stop();
    await client.close();
    await server.close();
  }
}

// [case, tool, arguments, argument path that the server refuses or null]
const CASES: Array<[string, string, Arguments, string | null]> = [
  ["a file list", "push_files", { branch: "main", files: [{ path: "a.md", content: "#" }] }, null],
  [
    "a file without content",
    "push_files",
    { branch: "main", files: [{ path: "a.md" }] },
    "files[0].content",
  ],
  ["a word as any value", "echo_value", { value: "hello" }, null],
  ["nested arrays as any value", "echo_value", { value: [[["a"], []], [[1]]] }, null],
  ["a text label", "set_labels", { labels: { team: "core" } }, null],
  ["a number label", "set_labels", { labels: { team: 1 } }, "labels.team"],
];

describe("MCP nested tool arguments at the planner boundary", () => {
  it.each(CASES)("%s", async (_name, tool, args, refusedPath) => {
    const accepted = refusedPath === null;
    const { result, serverAccepts, dispatched, delivered } = await plan(tool, args);
    expect(serverAccepts).toBe(accepted);
    expect(result.success === true).toBe(accepted);
    expect(dispatched).toEqual(accepted ? [tool] : []);
    expect(delivered).toEqual(accepted ? [args] : []);
    if (refusedPath) expect(String(result.error ?? result.text)).toContain(refusedPath);
  });
});
