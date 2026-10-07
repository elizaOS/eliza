/**
 * Tests the structured call_tool fast path: when the planner supplies
 * serverName/toolName (and optionally arguments), the handler must honor them
 * instead of re-deriving the selection with a second model pass. Pure-function
 * cases plus a stub-runtime handler run; no model selection prompt may fire
 * when the selection is explicit. Registered runtime cases exercise result
 * delivery over SDK stdio and SQLite with a deterministic synthesis capture.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ChannelType,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recentMessagesProvider } from "../../plugin-assistant/src/features/basic-capabilities/providers/recentMessages";
import { getDirectToolSelection, mcpAction } from "../src/actions/mcp";
import mcpPlugin from "../src/index";
import type { McpService } from "../src/service";

describe("getDirectToolSelection", () => {
  it("returns null without both serverName and toolName", () => {
    expect(getDirectToolSelection({ serverName: "srv" })).toBeNull();
    expect(getDirectToolSelection({ toolName: "echo" })).toBeNull();
    expect(getDirectToolSelection(undefined)).toBeNull();
    expect(getDirectToolSelection({ serverName: "  ", toolName: "echo" })).toBeNull();
  });

  it("trims names and passes object arguments through", () => {
    const selection = getDirectToolSelection({
      serverName: " srv ",
      toolName: " echo ",
      arguments: { x: 1 },
    });
    expect(selection).toEqual({
      serverName: "srv",
      toolName: "echo",
      toolArguments: { x: 1 },
      reasoning: "Selected from structured MCP call_tool parameters.",
    });
  });

  it("reads parameters nested under options.parameters", () => {
    const selection = getDirectToolSelection({
      parameters: { serverName: "srv", toolName: "echo", arguments: { q: "hi" } },
    });
    expect(selection?.toolArguments).toEqual({ q: "hi" });
  });

  it("parses a JSON string of arguments and drops a non-JSON one", () => {
    expect(
      getDirectToolSelection({
        serverName: "srv",
        toolName: "echo",
        arguments: '{"x":2}',
      })?.toolArguments
    ).toEqual({ x: 2 });

    const nonJson = getDirectToolSelection({
      serverName: "srv",
      toolName: "echo",
      arguments: "just words",
    });
    expect(nonJson?.toolArguments).toBeUndefined();
  });

  it("ignores array arguments and keeps an explicit reasoning", () => {
    const selection = getDirectToolSelection({
      serverName: "srv",
      toolName: "echo",
      arguments: [1, 2],
      reasoning: "planner picked it",
    });
    expect(selection?.toolArguments).toBeUndefined();
    expect(selection?.reasoning).toBe("planner picked it");
  });
});

describe("call_tool result through real stdio and SQLite", () => {
  const runtimes: ReturnType<typeof createSQLiteTestRuntime>[] = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.stop();
  });

  it.each(["only", "mixed", "error", "empty", "text", "echo", "echo-spaced"])(
    "retains the %s result in the action, synthesis input, and stored exchange",
    async (mode) => {
      const prompts: string[] = [];
      const callbacks: Parameters<HandlerCallback>[0][] = [];
      const fixture = fileURLToPath(new URL("./fixtures/paginated-server.mjs", import.meta.url));
      const runtime = createSQLiteTestRuntime({
        character: {
          name: "mcp-result-test",
          bio: "MCP result transport regression",
          settings: {
            mcp: {
              servers: {
                results: { type: "stdio", command: "node", args: [fixture, `result-${mode}`] },
              },
            },
          },
        },
        plugins: [
          mcpPlugin,
          {
            name: "result-synthesis-capture",
            description: "Capture actual model input; this is not live model inference",
            models: {
              [ModelType.TEXT_SMALL]: async (_runtime, input) => {
                prompts.push(input.prompt);
                return "Captured MCP synthesis";
              },
            },
          },
        ],
        logLevel: "fatal",
      });
      runtimes.push(runtime);
      runtime.registerProvider(recentMessagesProvider);
      await runtime.initialize();
      const service = (await runtime.getServiceLoadPromise("mcp")) as McpService;
      expect(service.getServers()[0].status).toBe("connected");
      const roomId = randomUUID();
      const entityId = randomUUID();
      const worldId = randomUUID();
      await runtime.ensureConnection({
        roomId,
        entityId,
        worldId,
        source: "mcp-test",
        type: ChannelType.DM,
      });
      const message: Memory = {
        id: randomUUID(),
        entityId,
        roomId,
        worldId,
        agentId: runtime.agentId,
        content: { text: "Call tool-2 and explain its result", source: "mcp-test" },
      };
      await runtime.createMemory(message, "messages");
      const payload =
        mode === "empty"
          ? {}
          : {
              temperature: 0,
              available: false,
              warning: null,
              nested: { labels: ["成都", "context"] },
              detail: "complete-detail".repeat(1_000),
            };
      const result = await mcpAction.handler(
        runtime,
        message,
        undefined,
        {
          action: "call_tool",
          serverName: "results",
          toolName: "tool-2",
          arguments: payload,
        },
        async (content) => {
          callbacks.push(content);
          return [];
        }
      );
      expect(result.success).toBe(mode !== "error");
      expect(result.data?.isError).toBe(mode === "error");
      expect(prompts).toHaveLength(1);
      const output = result.data?.output as string;
      if (mode === "text") {
        expect(output).toBe("Text summary from the tool");
      } else if (mode.startsWith("echo")) {
        expect(JSON.parse(output)).toEqual(payload);
      } else {
        expect(output).toContain(JSON.stringify(payload));
      }
      expect(prompts[0]).toContain(output);
      if (mode.startsWith("echo")) {
        const serialized = JSON.stringify(payload, null, mode === "echo" ? 0 : 2);
        expect(output.split(serialized)).toHaveLength(2);
        expect(prompts[0].split(serialized)).toHaveLength(2);
        if (mode === "echo-spaced") expect(output).toBe(` \n${serialized}\n `);
      }
      if (mode === "error") {
        expect(prompts[0]).toContain("The tool reported an ERROR");
        expect(result.error).toBeInstanceOf(Error);
      }
      const tools = await runtime.getMemories({ tableName: "tools", roomId, count: 10 });
      expect(tools).toHaveLength(1);
      expect(tools[0].content.text).toContain(output);
      const messages = await runtime.getMemories({ tableName: "messages", roomId, count: 10 });
      const reply = messages.find((memory) => memory.content.actions?.includes("CALL_MCP_TOOL"));
      expect(reply?.content.text).toBe("Captured MCP synthesis");
      expect(callbacks.at(-1)?.text).toBe(reply?.content.text);
      if (mode === "mixed") {
        expect(output).toContain("Text summary from the tool");
        expect(reply?.content.attachments).toEqual([
          expect.objectContaining({ url: "data:image/png;base64,AAAA" }),
        ]);
        expect(result.data?.attachmentCount).toBe(1);
      }
    }
  );
});

describe("call_tool with an explicit selection", () => {
  function makeHarness() {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "tool says hi" }],
    }));
    const useModel = vi.fn(async () => "reasoned reply");
    const runtime = {
      agentId: "agent-1",
      composeState: vi.fn(async () => ({ values: {}, data: {}, text: "" })),
      getService: vi.fn(() => ({
        getProviderData: () => ({ values: { mcp: {} }, data: { mcp: {} }, text: "" }),
        callTool,
      })),
      useModel,
      getModel: vi.fn(() => undefined),
      createMemory: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;
    const message = {
      entityId: "entity-1",
      roomId: "room-1",
      content: { text: "call the echo tool" },
    } as unknown as Memory;
    const callback = vi.fn(async () => []) as unknown as HandlerCallback;
    return { runtime, message, callback, callTool, useModel };
  }

  it("calls the named tool with the given arguments and skips model selection", async () => {
    const { runtime, message, callback, callTool, useModel } = makeHarness();

    const result = await mcpAction.handler(
      runtime,
      message,
      undefined,
      { action: "call_tool", serverName: "srv", toolName: "echo", arguments: { x: 1 } },
      callback
    );

    expect(callTool).toHaveBeenCalledWith("srv", "echo", { x: 1 });
    expect(result?.success).toBe(true);
    expect(result?.data?.toolArgumentsJson).toBe(JSON.stringify({ x: 1 }));
    // Only the response-synthesis model call may run — never a selection pass.
    expect(useModel).toHaveBeenCalledTimes(1);
  });
});
