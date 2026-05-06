import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnthropicClientLike } from "../backends/anthropic.js";
import {
  AnthropicBackend,
  CodexBackend,
  selectBackend,
} from "../backends/index.js";
import type { TurnMessage } from "../backends/types.js";
import { toAnthropicTools } from "../tool-format/anthropic.js";
import type { NativeTool } from "../tool-schema.js";

const ORIGINAL_ENV_BACKEND = process.env.NATIVE_REASONING_BACKEND;
const ORIGINAL_ENV_MODEL = process.env.ANTHROPIC_LARGE_MODEL;

afterEach(() => {
  if (ORIGINAL_ENV_BACKEND === undefined) {
    delete process.env.NATIVE_REASONING_BACKEND;
  } else {
    process.env.NATIVE_REASONING_BACKEND = ORIGINAL_ENV_BACKEND;
  }
  if (ORIGINAL_ENV_MODEL === undefined) {
    delete process.env.ANTHROPIC_LARGE_MODEL;
  } else {
    process.env.ANTHROPIC_LARGE_MODEL = ORIGINAL_ENV_MODEL;
  }
});

describe("selectBackend", () => {
  it("defaults to anthropic", () => {
    const b = selectBackend();
    expect(b.name).toBe("anthropic");
  });

  it("returns anthropic when explicitly requested", () => {
    const b = selectBackend({ backend: "anthropic" });
    expect(b.name).toBe("anthropic");
    expect(b).toBeInstanceOf(AnthropicBackend);
  });

  it("returns codex when env=codex", () => {
    process.env.NATIVE_REASONING_BACKEND = "codex";
    const b = selectBackend();
    expect(b.name).toBe("codex");
    expect(b).toBeInstanceOf(CodexBackend);
  });

  it("backend option overrides env", () => {
    process.env.NATIVE_REASONING_BACKEND = "codex";
    const b = selectBackend({ backend: "anthropic" });
    expect(b.name).toBe("anthropic");
  });

  it("falls back to anthropic on unknown env value", () => {
    process.env.NATIVE_REASONING_BACKEND = "vertex";
    const b = selectBackend();
    expect(b.name).toBe("anthropic");
  });
});

function makeMockClient(resp: {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}): { client: AnthropicClientLike; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => resp);
  const client: AnthropicClientLike = {
    beta: { messages: { create: create as any } },
  };
  return { client, create };
}

describe("AnthropicBackend.callTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("translates pure-text user turn to a string content", async () => {
    const { client, create } = makeMockClient({
      content: [{ type: "text", text: "hi" }],
    });
    const backend = new AnthropicBackend({ client });

    const messages: TurnMessage[] = [
      { role: "user", content: [{ type: "text", text: "yo" }] },
    ];

    const result = await backend.callTurn({
      systemPrompt: "system",
      messages,
      tools: [],
    });

    expect(create).toHaveBeenCalledOnce();
    const call = create.mock.calls[0]?.[0];
    expect(call.system).toBe("system");
    expect(call.messages[0]).toEqual({ role: "user", content: "yo" });
    expect(call.tools).toBeUndefined();
    expect(call.betas).toContain("advanced-tool-use-2025-11-20");

    expect(result.text).toBe("hi");
    expect(result.toolCalls).toEqual([]);
  });

  it("translates tool role → wire user role with tool_result blocks", async () => {
    const { client, create } = makeMockClient({
      content: [{ type: "text", text: "ok" }],
    });
    const backend = new AnthropicBackend({ client });

    const messages: TurnMessage[] = [
      { role: "user", content: [{ type: "text", text: "do" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "result",
          },
        ],
      },
    ];

    await backend.callTurn({ systemPrompt: "", messages, tools: [] });
    const wire = create.mock.calls[0]?.[0].messages;
    expect(wire[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }],
    });
  });

  it("extracts tool_use blocks into toolCalls and preserves rawAssistantBlocks", async () => {
    const { client } = makeMockClient({
      content: [
        { type: "text", text: "thinking" },
        {
          type: "tool_use",
          id: "u1",
          name: "search",
          input: { q: "foo" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const backend = new AnthropicBackend({ client });

    const result = await backend.callTurn({
      systemPrompt: "",
      messages: [{ role: "user", content: [{ type: "text", text: "search" }] }],
      tools: [],
    });

    expect(result.text).toBe("thinking");
    expect(result.toolCalls).toEqual([
      { id: "u1", name: "search", input: { q: "foo" } },
    ]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.usage).toEqual({ input: 10, output: 5 });
    expect(result.rawAssistantBlocks).toHaveLength(2);
  });

  it("forwards tools translated through toAnthropicTools", async () => {
    const { client, create } = makeMockClient({
      content: [{ type: "text", text: "k" }],
    });
    const backend = new AnthropicBackend({ client });
    const tools: NativeTool[] = [
      {
        type: "custom",
        name: "echo",
        description: "echoes",
        input_schema: { type: "object", properties: {} },
      },
    ];

    await backend.callTurn({
      systemPrompt: "",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools,
    });
    const call = create.mock.calls[0]?.[0];
    expect(call.tools).toEqual([
      {
        type: "custom",
        name: "echo",
        description: "echoes",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  it("retries on transient errors and eventually succeeds", async () => {
    let attempts = 0;
    const create = vi.fn(async () => {
      attempts++;
      if (attempts < 2) {
        const err: Error & { status?: number } = new Error("upstream 503");
        err.status = 503;
        throw err;
      }
      return { content: [{ type: "text", text: "ok" }] };
    });
    const client: AnthropicClientLike = {
      beta: { messages: { create: create as any } },
    };
    const backend = new AnthropicBackend({ client });

    const result = await backend.callTurn({
      systemPrompt: "",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [],
    });
    expect(attempts).toBe(2);
    expect(result.text).toBe("ok");
  });

  it("does not retry on non-transient (4xx) errors", async () => {
    let attempts = 0;
    const create = vi.fn(async () => {
      attempts++;
      const err: Error & { status?: number } = new Error("bad request");
      err.status = 400;
      throw err;
    });
    const client: AnthropicClientLike = {
      beta: { messages: { create: create as any } },
    };
    const backend = new AnthropicBackend({ client });

    await expect(
      backend.callTurn({
        systemPrompt: "",
        messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
        tools: [],
      }),
    ).rejects.toThrow(/bad request/);
    expect(attempts).toBe(1);
  });

  it("respects ANTHROPIC_LARGE_MODEL env", async () => {
    process.env.ANTHROPIC_LARGE_MODEL = "claude-test-model";
    const { client, create } = makeMockClient({
      content: [{ type: "text", text: "k" }],
    });
    const backend = new AnthropicBackend({ client });
    await backend.callTurn({
      systemPrompt: "",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [],
    });
    expect(create.mock.calls[0]?.[0].model).toBe("claude-test-model");
  });
});

describe("toAnthropicTools", () => {
  it("wraps NativeTool[] preserving fields", () => {
    const tools: NativeTool[] = [
      {
        type: "custom",
        name: "bash",
        description: "run bash",
        input_schema: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
      },
    ];
    const out = toAnthropicTools(tools);
    expect(out).toEqual([
      {
        type: "custom",
        name: "bash",
        description: "run bash",
        input_schema: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
      },
    ]);
  });

  it("returns empty array for no tools", () => {
    expect(toAnthropicTools([])).toEqual([]);
  });
});
