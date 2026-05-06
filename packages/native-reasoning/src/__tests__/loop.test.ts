import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnthropicClientLike } from "../loop.js";
import { runNativeReasoningLoop } from "../loop.js";
import { registerTool, type ToolRegistry } from "../tool-schema.js";

// Minimal stand-ins for runtime / message — the loop only touches a few
// fields. We type them as any to avoid pulling in a full @elizaos/core
// runtime mock for unit tests.
const fakeRuntime: any = {
  agentId: "00000000-0000-0000-0000-000000000001",
  character: { system: "You are a test agent." },
  getMemories: vi.fn(async () => []),
};

const fakeMessage: any = {
  id: "00000000-0000-0000-0000-000000000aaa",
  roomId: "00000000-0000-0000-0000-000000000bbb",
  entityId: "00000000-0000-0000-0000-000000000ccc",
  content: { text: "do the thing" },
};

function makeClient(turns: Array<{ content: any[]; stop_reason?: string }>): {
  client: AnthropicClientLike;
  create: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const create = vi.fn(async () => {
    const t = turns[Math.min(i, turns.length - 1)];
    i++;
    return t;
  });
  const client: AnthropicClientLike = {
    beta: { messages: { create: create as any } },
  };
  return { client, create };
}

describe("runNativeReasoningLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("short-circuits silently when model emits ignore tool_use", async () => {
    const { client } = makeClient([
      {
        content: [{ type: "tool_use", id: "t1", name: "ignore", input: {} }],
      },
    ]);
    const callback = vi.fn(async () => []);
    const registry: ToolRegistry = new Map();

    await runNativeReasoningLoop(fakeRuntime, fakeMessage, callback, {
      client,
      registry,
      systemPrompt: "ignore-test",
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it("returns final text via callback when no tool_use blocks", async () => {
    const { client, create } = makeClient([
      { content: [{ type: "text", text: "hello world" }] },
    ]);
    const callback = vi.fn(async () => []);

    await runNativeReasoningLoop(fakeRuntime, fakeMessage, callback, {
      client,
      systemPrompt: "test",
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      text: "hello world",
      attachments: [],
    });
  });

  it("executes a tool, appends result, and continues until final text", async () => {
    const { client, create } = makeClient([
      {
        content: [
          { type: "text", text: "thinking" },
          {
            type: "tool_use",
            id: "tu1",
            name: "echo",
            input: { msg: "hi" },
          },
        ],
      },
      { content: [{ type: "text", text: "done: hi" }] },
    ]);

    const handler = vi.fn(async (input: any) => ({
      content: `echoed:${input.msg}`,
    }));

    const registry: ToolRegistry = new Map();
    registerTool(
      registry,
      {
        type: "custom",
        name: "echo",
        description: "echoes",
        input_schema: { type: "object", properties: {} },
      },
      handler,
    );

    const callback = vi.fn(async () => []);
    await runNativeReasoningLoop(fakeRuntime, fakeMessage, callback, {
      client,
      registry,
      systemPrompt: "test",
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    // Second call should include the assistant + tool_result history.
    const secondMessages = create.mock.calls[1]?.[0].messages;
    expect(secondMessages.length).toBe(3); // user, assistant, tool_result
    expect(secondMessages[1].role).toBe("assistant");
    expect(secondMessages[2].role).toBe("user");
    const trBlocks = secondMessages[2].content;
    expect(trBlocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu1",
      content: "echoed:hi",
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: "done: hi" }),
    );
  });

  it("hits max turns gracefully with a stop message", async () => {
    // Always return another tool_use → loop never terminates on its own.
    const { client, create } = makeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "loop",
            name: "noop",
            input: {},
          },
        ],
      },
    ]);

    const registry: ToolRegistry = new Map();
    registerTool(
      registry,
      {
        type: "custom",
        name: "noop",
        description: "noop",
        input_schema: { type: "object", properties: {} },
      },
      async () => ({ content: "ok" }),
    );

    const callback = vi.fn(async () => []);
    await runNativeReasoningLoop(fakeRuntime, fakeMessage, callback, {
      client,
      registry,
      systemPrompt: "test",
      maxTurns: 3,
    });

    expect(create).toHaveBeenCalledTimes(3);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0].text).toMatch(/reasoning limit/);
  });

  it("returns unknown-tool error result instead of crashing", async () => {
    const { client, create } = makeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "x",
            name: "missing_tool",
            input: {},
          },
        ],
      },
      { content: [{ type: "text", text: "recovered" }] },
    ]);

    const callback = vi.fn(async () => []);
    await runNativeReasoningLoop(fakeRuntime, fakeMessage, callback, {
      client,
      registry: new Map(),
      systemPrompt: "test",
    });

    expect(create).toHaveBeenCalledTimes(2);
    const tr = create.mock.calls[1]?.[0].messages[2].content[0];
    expect(tr.is_error).toBe(true);
    expect(tr.content).toMatch(/Unknown tool/);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: "recovered" }),
    );
  });

  it("skips empty user text without calling Anthropic", async () => {
    const { client, create } = makeClient([
      { content: [{ type: "text", text: "should not happen" }] },
    ]);
    const callback = vi.fn(async () => []);
    await runNativeReasoningLoop(
      fakeRuntime,
      { ...fakeMessage, content: { text: "   " } } as any,
      callback,
      { client, systemPrompt: "test" },
    );
    expect(create).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });
});
