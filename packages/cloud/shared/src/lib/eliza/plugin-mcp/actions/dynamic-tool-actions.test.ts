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
  it("blocks invalid constraints before dispatch and preserves valid arguments", async () => {
    const received: unknown[] = [];
    const server = new Server(
      { name: "constraint-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      received.push(params.arguments);
      if (params.name === "transport-error") throw new Error("fixture service refusal");
      return { content: [{ type: "text", text: JSON.stringify(params.arguments) }] };
    });
    const client = new Client({ name: "constraint-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const service = {
      callTool: async (_server: string, name: string, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: args }),
    };
    const runtime = { getService: () => service } as unknown as IAgentRuntime;
    const cases = [
      { schema: { const: "safe" }, invalid: "unsafe", valid: "safe" },
      { schema: { enum: [null, false, 1, "safe"] }, invalid: true, valid: null },
      { schema: { oneOf: [{ type: "number", enum: [1, 2] }, { const: 2 }] }, invalid: 2, valid: 1 },
      { schema: { type: "integer" }, invalid: 1.5, valid: 2 },
    ];
    try {
      for (const [index, sample] of cases.entries()) {
        const tool: Tool = {
          name: `constraint-${index}`,
          inputSchema: {
            type: "object",
            properties: { value: sample.schema },
            required: ["value"],
          },
        };
        const action = createMcpToolAction("peer", tool, new Set());
        const before = received.length;
        const invalid = await action.handler(
          runtime,
          {
            content: { actionParams: { value: sample.invalid } },
          } as Memory,
          undefined,
          undefined,
        );
        expect(invalid.success).toBe(false);
        expect(invalid.data).toMatchObject({ code: "MCP_TOOL_ARGUMENTS_INVALID" });
        expect(received).toHaveLength(before);
        const valid = await action.handler(
          runtime,
          {
            content: { actionParams: { value: sample.valid } },
          } as Memory,
          undefined,
          undefined,
        );
        expect(valid.success).toBe(true);
        expect(received).toHaveLength(before + 1);
        expect(received.at(-1)).toEqual({ value: sample.valid });
      }
      const failed = await createMcpToolAction(
        "peer",
        {
          name: "transport-error",
          inputSchema: { type: "object", properties: { value: { const: "safe" } } },
        },
        new Set(),
      ).handler(
        runtime,
        {
          content: { actionParams: { value: "safe" } },
        } as Memory,
        undefined,
        undefined,
      );
      expect(failed.success).toBe(false);
      expect(failed.error).toContain("fixture service refusal");
      expect(received).toHaveLength(cases.length + 1);
    } finally {
      await client.close();
      await server.close();
    }
  });

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
