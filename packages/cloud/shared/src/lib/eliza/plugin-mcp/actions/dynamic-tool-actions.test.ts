import type { IAgentRuntime, Memory } from "@elizaos/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpToolAction } from "./dynamic-tool-actions";

describe("MCP dynamic action parameter boundary", () => {
  it("blocks an optional null over a real MCP transport and forwards an allowed null", async () => {
    const receivedArguments: Array<unknown> = [];
    const rejectedTool: Tool = {
      name: "set-mode",
      inputSchema: { type: "object", properties: { mode: { type: "string" } } },
    };
    const acceptedTool: Tool = {
      name: "set-mode",
      inputSchema: { type: "object", properties: { mode: { const: null } } },
    };
    const server = new Server(
      { name: "boundary-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [rejectedTool, acceptedTool],
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      receivedArguments.push(params.arguments);
      return { content: [{ type: "text", text: JSON.stringify(params.arguments) }] };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "boundary-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const service = {
      isLazyConnection: () => true,
      getServers: () => [
        { name: "peer", status: "connected", tools: [rejectedTool, acceptedTool] },
      ],
      callTool: async (_server: string, toolName: string, params: Record<string, unknown>) =>
        client.callTool({ name: toolName, arguments: params }),
    };
    const runtime = {
      getService: (name: string) => (name === "mcp" ? service : null),
    } as unknown as IAgentRuntime;
    const message = { content: { actionParams: { mode: null } } } as Memory;

    try {
      const rejected = await createMcpToolAction("peer", rejectedTool, new Set()).handler(
        runtime,
        message,
        undefined,
        undefined,
      );
      expect(rejected.success).toBe(false);
      expect(rejected.error).toContain("does not accept null");
      expect(receivedArguments).toEqual([]);

      const accepted = await createMcpToolAction("peer", acceptedTool, new Set()).handler(
        runtime,
        message,
        undefined,
        undefined,
      );
      expect(accepted.success).toBe(true);
      expect(receivedArguments).toEqual([{ mode: null }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
