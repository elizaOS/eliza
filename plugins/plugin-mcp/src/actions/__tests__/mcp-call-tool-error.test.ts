/**
 * Exercises the exported MCP action against deterministic runtime and service
 * stubs to prove structured tool failures remain failures through prompt
 * synthesis and the planner-facing action result.
 */

import type { HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { mcpAction } from "../mcp";

interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
}

function makeRuntime(toolResult: ToolResult) {
  const callTool = vi.fn(async () => toolResult);
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    composeState: vi.fn(async (): Promise<State> => ({ values: {}, data: {}, text: "" })),
    getService: vi.fn(() => ({
      getProviderData: () => ({
        values: { mcp: {} },
        data: { mcp: {} },
        text: "MCP servers: test-server",
      }),
      callTool,
    })),
    getModel: vi.fn(() => undefined),
    addEmbeddingToMemory: vi.fn(async (memory: Memory) => memory),
    createMemory: vi.fn(async () => "memory-id"),
    useModel: vi.fn(async () => "The tool operation failed."),
  } as unknown as IAgentRuntime;

  return { callTool, runtime };
}

const message = {
  entityId: "00000000-0000-0000-0000-0000000000bb",
  roomId: "00000000-0000-0000-0000-0000000000cc",
  content: { text: "run the tool", source: "test" },
} as unknown as Memory;

const options = {
  action: "call_tool",
  serverName: "test-server",
  toolName: "test-tool",
  arguments: { query: "complete" },
};

describe("MCP call_tool structured failure", () => {
  it("keeps an errored result and its complete detail out of the success path", async () => {
    const errorDetail = `Error from upstream: ${"complete-detail&".repeat(1_000)}`;
    const { callTool, runtime } = makeRuntime({
      content: [{ type: "text", text: errorDetail }],
      isError: true,
    });
    const callback = vi.fn(async () => {}) as unknown as HandlerCallback;

    const result = await mcpAction.handler(runtime, message, undefined, options, callback);

    expect(callTool).toHaveBeenCalledWith("test-server", "test-tool", { query: "complete" });
    expect(result.success).toBe(false);
    expect(result.values).toMatchObject({ success: false, toolExecuted: true, toolErrored: true });
    expect(result.text).not.toMatch(/Successfully called tool/i);
    expect(result.data).toMatchObject({ isError: true, output: errorDetail });
    expect(result.error).toBeInstanceOf(Error);

    const reasoningCall = vi
      .mocked(runtime.useModel)
      .mock.calls.find(
        ([model, input]) =>
          model === ModelType.TEXT_SMALL &&
          typeof input === "object" &&
          input !== null &&
          "prompt" in input &&
          typeof input.prompt === "string" &&
          input.prompt.includes("Synthesize the result")
      );
    expect(reasoningCall?.[1]).toMatchObject({
      prompt: expect.stringContaining(errorDetail),
    });
    expect(reasoningCall?.[1]).toMatchObject({
      prompt: expect.stringContaining("The tool reported an ERROR"),
    });
  });

  it("preserves the existing success result when isError is absent", async () => {
    const { runtime } = makeRuntime({ content: [{ type: "text", text: "requested data" }] });

    const result = await mcpAction.handler(runtime, message, undefined, options, undefined);

    expect(result.success).toBe(true);
    expect(result.values).toMatchObject({ success: true, toolExecuted: true });
    expect(result.data).toMatchObject({ isError: false, output: "requested data" });
    expect(result.text).toMatch(/Successfully called tool/i);
  });
});
