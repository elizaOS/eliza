/**
 * Regression coverage for the MCP call_tool action's handling of a
 * spec-compliant errored CallToolResult (#30037). Exercises the real exported
 * `mcpAction.handler` against a stub runtime and a stub `McpService` whose
 * `callTool` returns `{ isError: true }`. Guards the contract that a tool that
 * reports execution failure yields a distinct `ActionResult` with
 * `success:false` — never the fabricated "Successfully called tool" / success
 * result the planner previously recorded — while the success path still reports
 * success. The harness is deterministic; no live MCP server or model is used.
 */

import type { HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { mcpAction } from "../mcp";

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

function makeRuntime(callToolResult: ToolResult) {
  const callTool = vi.fn(async () => callToolResult);
  const providerData = {
    values: { mcp: {} },
    data: { mcp: {} },
    text: "MCP servers: srv",
  };
  const mcpService = {
    getProviderData: () => providerData,
    callTool,
  };

  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    composeState: vi.fn(async (): Promise<State> => ({ values: {}, data: {}, text: "" })),
    getService: vi.fn(() => mcpService),
    getModel: vi.fn(() => undefined),
    addEmbeddingToMemory: vi.fn(async (m: Memory) => m),
    createMemory: vi.fn(async () => "mem-id"),
    useModel: vi.fn(async () => "A reasoned, user-facing sentence about the outcome."),
  } as unknown as IAgentRuntime;

  return { runtime, callTool };
}

const message = {
  entityId: "00000000-0000-0000-0000-0000000000bb",
  roomId: "00000000-0000-0000-0000-0000000000cc",
  content: { text: "call the flaky tool", source: "test" },
} as unknown as Memory;

const options = {
  action: "call_tool",
  serverName: "srv",
  toolName: "toolX",
  arguments: { q: "hi" },
};

describe("MCP call_tool action — errored CallToolResult (#30037)", () => {
  it("returns success:false and drops the success narration when isError:true", async () => {
    const { runtime, callTool } = makeRuntime({
      content: [{ type: "text", text: "Error: upstream API returned 500" }],
      isError: true,
    });
    const callback = vi.fn(async () => {}) as unknown as HandlerCallback;

    const result = await mcpAction.handler(runtime, message, undefined, options, callback);

    expect(callTool).toHaveBeenCalledWith("srv", "toolX", { q: "hi" });
    expect(result.success).toBe(false);
    expect(result.values?.success).toBe(false);
    expect(result.values?.toolErrored).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
    // The planner must not be told the call succeeded.
    expect(result.text).not.toMatch(/Successfully called tool/i);
    expect(result.text).toMatch(/reported an error/i);
    // The error detail is still preserved for downstream inspection.
    expect(result.data?.isError).toBe(true);
    expect(result.data?.output).toContain("upstream API returned 500");
    // The user was still informed via the reasoning reply.
    expect(runtime.useModel).toHaveBeenCalledWith(ModelType.TEXT_SMALL, expect.anything());
  });

  it("still reports success:true for a normal successful CallToolResult", async () => {
    const { runtime } = makeRuntime({
      content: [{ type: "text", text: "the answer is 42" }],
    });

    const result = await mcpAction.handler(runtime, message, undefined, options, undefined);

    expect(result.success).toBe(true);
    expect(result.values?.success).toBe(true);
    expect(result.values?.toolExecuted).toBe(true);
    expect(result.data?.isError).toBe(false);
    expect(result.text).toMatch(/Successfully called tool/i);
  });

  it("frames the reasoning prompt as a failure when the tool errored", async () => {
    const { runtime } = makeRuntime({
      content: [{ type: "text", text: "Error: invalid API key" }],
      isError: true,
    });

    await mcpAction.handler(runtime, message, undefined, options, undefined);

    const reasoningCall = (runtime.useModel as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, arg]) => typeof arg?.prompt === "string" && arg.prompt.includes("Synthesize the result")
    );
    expect(reasoningCall).toBeDefined();
    expect(reasoningCall?.[1].prompt).toMatch(/reported an ERROR/);
  });
});
