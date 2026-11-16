/**
 * Nested MCP tool arguments at the cloud planner boundary.
 *
 * The cloud native planner (cloud-bootstrap-message-service) hands every tool
 * call to executePlannedToolCall, which validates the arguments against the
 * action parameters that convertJsonSchemaToActionParams built from the tool's
 * inputSchema. Only then does the action handler send them to the MCP server.
 * The server here is a real MCP SDK server that validates its own zod schemas.
 */
import { readFileSync } from "node:fs";
import {
  type Action,
  type ActionResult,
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
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpToolAction } from "./dynamic-tool-actions";

type ToolName = "push_files" | "create_page" | "sum_ids" | "echo_value" | "set_labels";
type Arguments = Record<string, unknown>;
interface ModelCase {
  tool: ToolName;
  shape: string;
  serverAccepts: boolean;
  admitted: boolean;
  delivered: boolean;
}

// Shapes of real servers: server-github push_files, Notion create_page,
// pydantic list[int], Any and dict[str, str].
const ARGUMENTS: Record<ToolName, Record<string, Arguments>> = {
  push_files: {
    valid: { branch: "main", files: [{ path: "README.md", content: "# docs" }] },
    missingContent: { branch: "main", files: [{ path: "README.md" }] },
  },
  create_page: {
    valid: { parent: { page_id: "59833787" }, title: "Notes" },
    missingPageId: { parent: {}, title: "Notes" },
  },
  sum_ids: {
    valid: { ids: [3, 4] },
    wordItem: { ids: ["three"] },
  },
  echo_value: {
    text: { value: "hello" },
    object: { value: { a: 1 } },
  },
  set_labels: {
    valid: { labels: { team: "core" } },
    numberValue: { labels: { team: 1 } },
  },
};
// The second shape of each tool breaks the server's schema, except for Any.
const SERVER_ACCEPTS = new Set(["valid", "text", "object"]);
// Without the model's env variable, every group replays all of its cases.
const DEFAULT_CASES: ModelCase[] = (Object.keys(ARGUMENTS) as ToolName[]).flatMap((tool) =>
  Object.keys(ARGUMENTS[tool]).map((shape) => ({
    tool,
    shape,
    serverAccepts: SERVER_ACCEPTS.has(shape),
    admitted: SERVER_ACCEPTS.has(shape),
    delivered: SERVER_ACCEPTS.has(shape),
  })),
);
const MODEL_CASES: ModelCase[] = process.env.ELIZA_MCP_ARGUMENT_SHAPE_MODEL_CASES
  ? JSON.parse(readFileSync(process.env.ELIZA_MCP_ARGUMENT_SHAPE_MODEL_CASES, "utf8"))
  : DEFAULT_CASES;

async function connectServer() {
  const delivered: Array<{ tool: string; args: unknown }> = [];
  const server = new McpServer({ name: "nested-shape-server", version: "1.0.0" });
  const record = (tool: ToolName) => async (args: unknown) => {
    delivered.push({ tool, args });
    return { content: [{ type: "text" as const, text: JSON.stringify(args) }] };
  };
  server.registerTool(
    "push_files",
    {
      description: "Push files to a branch",
      inputSchema: {
        branch: z.string(),
        files: z.array(z.object({ path: z.string(), content: z.string() })),
      },
    },
    record("push_files"),
  );
  server.registerTool(
    "create_page",
    {
      description: "Create a page under a parent page",
      inputSchema: { parent: z.object({ page_id: z.string() }), title: z.string() },
    },
    record("create_page"),
  );
  server.registerTool(
    "sum_ids",
    { description: "Sum ids", inputSchema: { ids: z.array(z.number().int()) } },
    record("sum_ids"),
  );
  server.registerTool(
    "echo_value",
    { description: "Echo any value", inputSchema: { value: z.any() } },
    record("echo_value"),
  );
  server.registerTool(
    "set_labels",
    {
      description: "Set labels",
      inputSchema: { labels: z.record(z.string(), z.string()) },
    },
    record("set_labels"),
  );
  const client = new Client({ name: "nested-shape-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  return {
    client,
    tools,
    delivered,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

type Connection = Awaited<ReturnType<typeof connectServer>>;

/** The tools of one connected server, as the cloud MCP service exposes them. */
function mcpServiceFor(connection: Connection, dispatched: string[]) {
  return class ConnectedMcpService extends Service {
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
      return [{ name: "peer", status: "connected", tools: connection.tools }];
    }
    async callTool(_server: string, toolName: string, params: Arguments) {
      dispatched.push(toolName);
      return (await connection.client.callTool({
        name: toolName,
        arguments: params,
      })) as CallToolResult;
    }
  };
}

/** Whether the server itself accepts the arguments, without the planner. */
async function serverAccepts(connection: Connection, tool: ToolName, args: Arguments) {
  const before = connection.delivered.length;
  let result: CallToolResult | undefined;
  try {
    result = (await connection.client.callTool({ name: tool, arguments: args })) as CallToolResult;
  } catch {
    result = undefined;
  }
  const accepted = connection.delivered.length === before + 1 && result?.isError !== true;
  connection.delivered.splice(before);
  return accepted;
}

async function plan(tool: ToolName, args: Arguments) {
  const connection = await connectServer();
  const dispatched: string[] = [];
  const ownerId = crypto.randomUUID() as UUID;
  const worldId = crypto.randomUUID() as UUID;
  const roomId = crypto.randomUUID() as UUID;
  const runtime = createSQLiteTestRuntime({
    character: {
      name: "NestedArgumentsAgent",
      bio: ["MCP argument fixture"],
      settings: { ELIZA_ADMIN_ENTITY_ID: ownerId },
    },
    plugins: [
      {
        name: "connected-mcp",
        description: "One connected MCP server",
        services: [mcpServiceFor(connection, dispatched)],
      },
    ],
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
    const names = new Set<string>();
    const actions = connection.tools.map((entry: Tool) => {
      const action = createMcpToolAction("peer", entry, names);
      names.add(action.name);
      // As the cloud MCP service registers its tool actions (service.ts).
      runtime.registerAction(action as Action);
      return action;
    });
    const action = actions[connection.tools.findIndex((entry) => entry.name === tool)];
    const accepted = await serverAccepts(connection, tool, args);
    // The message and state that the cloud native planner builds for a tool call.
    const message: Memory = {
      id: crypto.randomUUID() as UUID,
      entityId: ownerId,
      roomId,
      content: {
        text: `run ${tool}`,
        params: args,
        actionParams: args,
        actionInput: args,
      } as Content,
    };
    const state = { values: {}, data: { actionParams: args }, text: "" } as State;
    const result: ActionResult = await executePlannedToolCall(
      runtime,
      {
        message,
        state,
        activeContexts: ["connectors"],
        previousResults: [],
      },
      { name: action.name, params: args },
    );
    return {
      result,
      accepted,
      parameters: action.parameters,
      dispatched,
      delivered: connection.delivered.map((entry) => entry.args),
    };
  } finally {
    await runtime.stop();
    await connection.close();
  }
}

async function replay(item: ModelCase) {
  const args = ARGUMENTS[item.tool][item.shape];
  expect(args, `${item.tool}/${item.shape}`).toBeDefined();
  const { result, accepted, dispatched, delivered } = await plan(item.tool, args);
  expect(accepted, `${item.tool}/${item.shape} server`).toBe(item.serverAccepts);
  expect(dispatched.length === 1, `${item.tool}/${item.shape} admitted`).toBe(item.admitted);
  expect(delivered, `${item.tool}/${item.shape} delivered`).toEqual(item.delivered ? [args] : []);
  expect(result.success === true).toBe(item.delivered);
}

describe("MCP nested tool arguments at the planner boundary", () => {
  it("sends server-github push_files a file list", async () => {
    const { result, dispatched, delivered } = await plan("push_files", ARGUMENTS.push_files.valid);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(dispatched).toEqual(["push_files"]);
    expect(delivered).toEqual([ARGUMENTS.push_files.valid]);
  });

  it("refuses a file without content before dispatch", async () => {
    const { result, accepted, dispatched } = await plan(
      "push_files",
      ARGUMENTS.push_files.missingContent,
    );
    expect(accepted).toBe(false);
    expect(result.success).toBe(false);
    expect(String(result.error ?? result.text)).toContain("files[0].content");
    expect(dispatched).toEqual([]);
  });

  it("sends a word to a property without a type", async () => {
    const { result, delivered } = await plan("echo_value", ARGUMENTS.echo_value.text);
    expect(result.error).toBeUndefined();
    expect(delivered).toEqual([ARGUMENTS.echo_value.text]);
  });

  const groups = (Object.keys(ARGUMENTS) as ToolName[]).map((tool) => ({
    name: tool,
    cases: MODEL_CASES.filter((item) => item.tool === tool),
  }));
  it.each(groups)("argument model replays $name", async ({ cases }) => {
    expect(cases.length).toBeGreaterThan(0);
    for (const item of cases) await replay(item);
  });
});
