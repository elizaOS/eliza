/**
 * Tests the structured call_tool fast path: when the planner supplies
 * serverName/toolName (and optionally arguments), the handler must honor them
 * instead of re-deriving the selection with a second model pass. Pure-function
 * cases plus a stub-runtime handler run; no model selection prompt may fire
 * when the selection is explicit.
 */
import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { getDirectToolSelection, mcpAction } from "../src/actions/mcp";

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
