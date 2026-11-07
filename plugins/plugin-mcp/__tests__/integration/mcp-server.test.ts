/**
 * Opt-in integration tests for real MCP server connectivity.
 * The npx-backed lane is gated by ELIZA_MCP_NPX_INTEGRATION because package-manager and registry delays can exceed the normal unit timeout.
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ChannelType, type Content, type Memory, ModelType } from "@elizaos/core";
import { createPerfectResultPlugin } from "@elizaos/testing/models";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recentMessagesProvider } from "../../../plugin-assistant/src/features/basic-capabilities/providers/recentMessages";
import mcpPlugin from "../../src/index";
import type { McpService } from "../../src/service";

const runNpxMcpServerTests = process.env.ELIZA_MCP_NPX_INTEGRATION === "1";

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("MCP Server Integration", () => {
  describe("StdioClientTransport", () => {
    let transport: StdioClientTransport | null = null;
    let client: Client | null = null;

    afterAll(async () => {
      if (transport) {
        await transport.close().catch(() => {});
      }
      if (client) {
        await client.close().catch(() => {});
      }
    });

    it.skipIf(!runNpxMcpServerTests)(
      "should connect to a stdio MCP server",
      async () => {
        // Skip if npx is not available
        if (!commandExists("npx")) {
          console.log("Skipping test: npx not available");
          return;
        }

        // Create transport to the memory MCP server
        transport = new StdioClientTransport({
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-memory"],
          stderr: "pipe",
        });

        client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

        // Connect may fail if npx cannot fetch the package (network/registry issues).
        // Treat that as a skip rather than a hard failure of the test surface.
        try {
          await client.connect(transport);
        } catch (err) {
          console.log("Skipping test: failed to start MCP server via npx", err);
          return;
        }

        // Should be able to list tools
        const toolsResponse = await client.listTools();
        expect(toolsResponse).toBeDefined();
        expect(Array.isArray(toolsResponse.tools)).toBe(true);

        // Close gracefully
        await transport.close();
        await client.close();
        transport = null;
        client = null;
      },
      60000
    );

    it("should handle server errors gracefully", async () => {
      // Try to connect to a non-existent server
      const badTransport = new StdioClientTransport({
        command: "non-existent-command-that-should-fail",
        args: [],
        stderr: "pipe",
      });

      const badClient = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

      // Connection should fail
      let errorThrown = false;
      try {
        await badClient.connect(badTransport);
      } catch (_error) {
        errorThrown = true;
      }

      expect(errorThrown).toBe(true);

      await badTransport.close().catch(() => {});
      await badClient.close().catch(() => {});
    }, 10000);
  });

  describe.skipIf(!runNpxMcpServerTests)("Tool Calling", () => {
    let transport: StdioClientTransport | null = null;
    let client: Client | null = null;

    beforeAll(async () => {
      if (!commandExists("npx")) {
        return;
      }

      transport = new StdioClientTransport({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        stderr: "pipe",
      });

      client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

      try {
        await client.connect(transport);
      } catch (err) {
        console.log("Skipping Tool Calling tests: failed to start MCP server via npx", err);
        await transport.close().catch(() => {});
        await client.close().catch(() => {});
        transport = null;
        client = null;
      }
    }, 60000);

    afterAll(async () => {
      if (transport) {
        await transport.close().catch(() => {});
      }
      if (client) {
        await client.close().catch(() => {});
      }
    });

    it("should list available tools from the server", async () => {
      if (!client) {
        console.log("Skipping test: client not initialized");
        return;
      }

      const response = await client.listTools();
      expect(response.tools).toBeDefined();
      expect(Array.isArray(response.tools)).toBe(true);
    });

    it("should call a tool with arguments", async () => {
      if (!client) {
        console.log("Skipping test: client not initialized");
        return;
      }

      const tools = await client.listTools();
      if (tools.tools.length === 0) {
        console.log("Skipping test: no tools available");
        return;
      }

      // Try to call the store_memory tool if available
      const storeTool = tools.tools.find((t) => t.name === "store_memory");
      if (storeTool) {
        const result = await client.callTool({
          name: "store_memory",
          arguments: {
            key: "test-key",
            value: "test-value",
          },
        });
        expect(result).toBeDefined();
        expect(result.content).toBeDefined();
      }
    });
  });
});

describe("MCP tool schema dialects through model argument selection", () => {
  const fixture = fileURLToPath(new URL("../fixtures/schema-dialect-server.mjs", import.meta.url));
  const cases = [
    { tool: "implicit", pair: ["task", 0], valid: true },
    { tool: "explicit", pair: ["task", 0], valid: true },
    { tool: "legacy", pair: ["task", 0], valid: true },
    { tool: "legacyUndeclared", pair: ["task", 0], valid: true },
    { tool: "implicit", pair: [0, "task"], valid: false },
    { tool: "explicit", pair: ["task", 0, 1], valid: false },
    { tool: "legacy", pair: [0, "task"], valid: false },
    { tool: "legacyUndeclared", pair: [0, "task"], valid: false },
    { tool: "declaredMismatch", pair: ["task", 0], valid: false },
    { tool: "unsupported", pair: ["task", 0], valid: false },
  ];

  it.each(cases)(
    "validates $tool/$pair before invoking the server",
    async ({ tool, pair, valid }) => {
      const modelCalls: Array<{ type: string; prompt: string }> = [];
      const model = createPerfectResultPlugin({
        fixtures: [
          {
            name: "argument-selection",
            match: { modelType: ModelType.TEXT_LARGE },
            times: { min: 1, max: 3 },
            response: (call) => {
              modelCalls.push({ type: call.modelType, prompt: call.params.prompt ?? "" });
              return JSON.stringify({ toolArguments: { pair } });
            },
          },
          ...(valid
            ? [
                {
                  name: "tool-response",
                  match: { modelType: ModelType.TEXT_SMALL },
                  times: 1,
                  response: (call) => {
                    modelCalls.push({ type: call.modelType, prompt: call.params.prompt ?? "" });
                    return "The tool received the pair.";
                  },
                },
              ]
            : []),
        ],
      });
      const runtime = createSQLiteTestRuntime({
        character: {
          name: "mcp-schema-dialects",
          bio: "Use tool schemas without losing their validation rules",
          settings: {
            mcp: {
              servers: { peer: { type: "stdio", command: "node", args: [fixture] } },
            },
          },
        },
        plugins: [mcpPlugin, model],
        logLevel: "fatal",
      });
      try {
        await runtime.initialize();
        runtime.registerProvider(recentMessagesProvider);
        const service = (await runtime.getServiceLoadPromise("mcp")) as McpService;
        expect(service.getServers()[0].status).toBe("connected");
        expect(service.getServers()[0].tools?.map((entry) => entry.name)).toEqual([
          "implicit",
          "explicit",
          "legacy",
          "legacyUndeclared",
          "declaredMismatch",
          "unsupported",
        ]);
        const roomId = randomUUID(),
          entityId = randomUUID(),
          worldId = randomUUID();
        await runtime.ensureConnection({
          roomId,
          entityId,
          worldId,
          source: "mcp-integration",
          type: ChannelType.DM,
        });
        const message: Memory = {
          id: randomUUID(),
          roomId,
          entityId,
          worldId,
          agentId: runtime.agentId,
          content: {
            text: `Use ${tool} with the pair ${JSON.stringify(pair)}.`,
            source: "mcp-integration",
          },
        };
        await runtime.createMemory(message, "messages");
        const action = runtime.actions.find((entry) => entry.name === "MCP");
        if (!action?.handler) throw new Error("Registered MCP action is missing");
        const callbacks: Content[] = [];
        const result = await action.handler(
          runtime,
          message,
          undefined,
          { parameters: { op: "call_tool", serverName: "peer", toolName: tool } },
          async (content) => {
            callbacks.push(content);
            return [];
          }
        );
        if (!result || typeof result !== "object") throw new Error("Expected action result");
        expect(result.success).toBe(true);
        expect(result.values?.toolExecuted === true).toBe(valid);
        expect(result.data?.noToolAvailable === true).toBe(!valid);
        const readback = (await service.readResource("peer", "fixture:///calls")).contents[0];
        if (typeof readback.text !== "string") throw new Error("Expected invocation receipt");
        const invocations = JSON.parse(readback.text);
        expect(invocations).toEqual(valid ? [{ name: tool, arguments: { pair } }] : []);
        const memories = await runtime.getMemories({ tableName: "messages", roomId, count: 20 });
        const saved = memories.find((memory) => memory.content.actions?.includes("CALL_MCP_TOOL"));
        expect(Boolean(saved)).toBe(valid);
        if (valid) {
          expect(result.data?.output).toContain(JSON.stringify(pair));
          expect(saved?.content.text).toBe(callbacks.at(-1)?.text);
          expect(modelCalls.at(-1)?.prompt).toContain(JSON.stringify(pair));
        }
        expect(modelCalls.map((call) => call.type)).toEqual(
          valid
            ? [ModelType.TEXT_LARGE, ModelType.TEXT_SMALL]
            : [ModelType.TEXT_LARGE, ModelType.TEXT_LARGE, ModelType.TEXT_LARGE]
        );
        model.assertFixturesConsumed();
        if (tool === "unsupported") {
          expect(modelCalls[1]?.prompt).toContain("Unsupported MCP JSON Schema dialect");
        }
        console.info(
          "MCP schema dialect receipt:",
          JSON.stringify({
            tool,
            pair,
            success: result.success,
            invocations,
            storedReply: Boolean(saved),
          })
        );
      } finally {
        await runtime.stop();
      }
    }
  );
});

describe("MCP argument retry recovery", () => {
  const peer = fileURLToPath(new URL("../fixtures/schema-dialect-server.mjs", import.meta.url));
  const scenarios = [
    { name: "direct malformed JSON", direct: true, first: "not JSON", recover: true },
    {
      name: "direct wrong type",
      direct: true,
      first: '{"toolArguments":{"pair":["task","0"]}}',
      recover: true,
    },
    {
      name: "inferred wrong type",
      direct: false,
      first: '{"toolArguments":{"pair":["task","0"]}}',
      recover: true,
    },
    { name: "inferred malformed JSON", direct: false, first: "not JSON", recover: true },
    {
      name: "invalid through exhaustion",
      direct: true,
      first: '{"toolArguments":{"pair":[0,"task"]}}',
      recover: false,
    },
    {
      name: "valid first response",
      direct: true,
      first: '{"toolArguments":{"pair":["task",0]}}',
      recover: true,
    },
    {
      name: "recover on last retry",
      direct: true,
      first: "not JSON",
      second: '{"toolArguments":{"pair":["task","0"]}}',
      recover: true,
    },
  ];
  it.each(scenarios)("$name", async ({ direct, first, second, recover }) => {
    const requests: Array<{ type: string; prompt: string; output: string }> = [];
    let argumentAttempts = 0;
    const models = createPerfectResultPlugin({
      fixtures: [
        {
          name: "selection-and-recovery",
          match: { modelType: ModelType.TEXT_LARGE },
          times: { min: 1, max: 4 },
          response: (call) => {
            const prompt = call.params.prompt ?? "";
            let output: string;
            // Follow the requested stage's output contract, like a model does.
            if (prompt.includes("# TASK: Generate Tool Arguments for Tool Execution")) {
              argumentAttempts += 1;
              output =
                argumentAttempts === 1 || !recover
                  ? first
                  : argumentAttempts === 2 && second
                    ? second
                    : JSON.stringify({ toolArguments: { pair: ["task", 0] } });
            } else {
              output = JSON.stringify({
                serverName: "peer",
                toolName: "explicit",
                noToolAvailable: false,
              });
            }
            requests.push({ type: call.modelType, prompt, output });
            return output;
          },
        },
        {
          name: "response-synthesis",
          match: { modelType: ModelType.TEXT_SMALL },
          times: { min: 0, max: 1 },
          response: (call) => {
            const output = "Received task and integer zero.";
            requests.push({ type: call.modelType, prompt: call.params.prompt ?? "", output });
            return output;
          },
        },
      ],
    });
    const runtime = createSQLiteTestRuntime({
      character: {
        name: "mcp-argument-retry",
        bio: "Recover an invalid tool argument response without selecting another tool",
        settings: { mcp: { servers: { peer: { type: "stdio", command: "node", args: [peer] } } } },
      },
      plugins: [mcpPlugin, models],
      logLevel: "fatal",
    });
    try {
      runtime.registerProvider(recentMessagesProvider);
      await runtime.initialize();
      const service = (await runtime.getServiceLoadPromise("mcp")) as McpService;
      expect(service.getServers()[0].status).toBe("connected");
      const roomId = randomUUID(),
        entityId = randomUUID(),
        worldId = randomUUID();
      await runtime.ensureConnection({
        roomId,
        entityId,
        worldId,
        source: "mcp-retry",
        type: ChannelType.DM,
      });
      const text =
        'Use explicit on peer with the exact pair ["task",0]; the second item is an integer.';
      const message: Memory = {
        id: randomUUID(),
        roomId,
        entityId,
        worldId,
        agentId: runtime.agentId,
        content: { text, source: "mcp-retry" },
      };
      await runtime.createMemory(message, "messages");
      const action = runtime.actions.find((entry) => entry.name === "MCP");
      if (!action?.handler) throw new Error("Registered MCP action missing");
      const callbacks: Content[] = [];
      const result = await action.handler(
        runtime,
        message,
        undefined,
        {
          parameters: {
            op: "call_tool",
            ...(direct ? { serverName: "peer", toolName: "explicit" } : {}),
          },
        },
        async (content) => {
          callbacks.push(content);
          return [];
        }
      );
      if (!result || typeof result !== "object") throw new Error("Expected action result");
      const receipt = (await service.readResource("peer", "fixture:///calls")).contents[0];
      if (typeof receipt.text !== "string") throw new Error("Expected tool invocation receipt");
      const invocations = JSON.parse(receipt.text);
      expect(result.values?.toolExecuted === true).toBe(recover);
      expect(invocations).toEqual(
        recover ? [{ name: "explicit", arguments: { pair: ["task", 0] } }] : []
      );
      const rows = await runtime.getMemories({ tableName: "messages", roomId, count: 20 });
      const reply = rows.find((row) => row.content.actions?.includes("CALL_MCP_TOOL"));
      expect(Boolean(reply)).toBe(recover);
      const large = requests.filter((request) => request.type === ModelType.TEXT_LARGE);
      const firstArgumentIndex = direct ? 0 : 1;
      const retried = first !== '{"toolArguments":{"pair":["task",0]}}';
      expect(large).toHaveLength(
        firstArgumentIndex + (recover ? (second ? 3 : retried ? 2 : 1) : 3)
      );
      if (retried) {
        const feedback = large[firstArgumentIndex + 1].prompt;
        const schema = service.getProviderData().data.mcp.peer.tools.explicit.inputSchema;
        expect(feedback).toContain(JSON.stringify(schema));
        expect(feedback).toContain(first);
        expect(feedback).toContain(text);
        expect(feedback).toContain('"explicit" tool from the "peer" server');
        expect(feedback).toContain("toolArguments");
        expect(feedback).toContain(
          first === "not JSON" ? "parsed or validated" : "Invalid arguments"
        );
        if (second) {
          const finalFeedback = large[firstArgumentIndex + 2].prompt;
          expect(finalFeedback).toContain(second);
          expect(finalFeedback).not.toContain("Your previous response:\nnot JSON");
          expect(finalFeedback).toContain("Invalid arguments");
          expect(finalFeedback).toContain(JSON.stringify(schema));
          expect(finalFeedback).toContain(text);
        }
      }
      if (recover) {
        expect(reply?.content.text).toBe(callbacks.at(-1)?.text);
        expect(requests.at(-1)?.type).toBe(ModelType.TEXT_SMALL);
        expect(requests.at(-1)?.prompt).toContain(JSON.stringify(["task", 0]));
      } else {
        expect(result.data?.noToolAvailable).toBe(true);
        expect(requests.every((request) => request.type === ModelType.TEXT_LARGE)).toBe(true);
      }
      models.assertFixturesConsumed();
      console.info(
        "MCP retry receipt:",
        JSON.stringify({ direct, first, recover, invocations, storedReply: Boolean(reply) })
      );
    } finally {
      await runtime.stop();
    }
  });
});
