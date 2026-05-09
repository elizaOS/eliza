import type { GenerateTextResult, IAgentRuntime, TextStreamResult } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateTextMock, streamTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  streamTextMock: vi.fn(),
}));

vi.mock("ai", () => ({
  embed: vi.fn(),
  generateObject: vi.fn(),
  generateText: (...args: unknown[]) => generateTextMock(...args),
  streamText: (...args: unknown[]) => streamTextMock(...args),
  jsonSchema: vi.fn((schema: unknown) => schema),
  Output: {
    object: vi.fn((spec: unknown) => ({ kind: "output.object", spec })),
  },
}));

vi.mock("ollama-ai-provider-v2", () => ({
  createOllama: vi.fn(() => {
    const ollama = vi.fn((model: string) => ({ model }));
    return Object.assign(ollama, {
      embedding: vi.fn((model: string) => ({ model })),
    });
  }),
}));

vi.mock("../models/availability", () => ({
  ensureModelAvailable: vi.fn(async () => undefined),
}));

import { handleResponseHandler, handleTextLarge, handleTextSmall } from "../models/text";
import { normalizeNativeTools } from "../utils/ai-sdk-wire";

function createRuntime() {
  const runtime = {
    character: { system: "system prompt" },
    emitEvent: vi.fn(),
    getSetting: vi.fn(() => undefined),
  };

  return runtime as IAgentRuntime;
}

function expectGenerateTextResult(value: unknown): asserts value is GenerateTextResult {
  expect(value).toEqual(expect.objectContaining({ text: expect.any(String) }));
}

function createFailingTextStream(message: string): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          throw new Error(message);
        },
      };
    },
  };
}

describe("Ollama native text plumbing", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() => ({
      textStream: (async function* () {})(),
      text: Promise.resolve(""),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve(undefined),
    }));
  });

  it("forwards native ToolSet tools to generateText and returns a GenerateTextResult-shaped payload", async () => {
    generateTextMock.mockResolvedValue({
      text: "ack",
      toolCalls: [{ toolCallId: "call-1", toolName: "lookup", input: { q: "x" } }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2 },
    });

    const result = await handleTextSmall(createRuntime(), {
      prompt: "use a tool",
      tools: { lookup: { description: "Lookup", inputSchema: { type: "object" } } },
    } as never);
    expectGenerateTextResult(result);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const callArg = generateTextMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.tools).toEqual({
      lookup: { description: "Lookup", inputSchema: { type: "object" } },
    });
    expect(callArg.toolChoice).toBeUndefined();

    expect(result.text).toBe("ack");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({
      id: "call-1",
      name: "lookup",
      arguments: { q: "x" },
    });
    expect(result.usage).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    });
  });

  it("infers root array schemas for native tool parameters", () => {
    const tools = normalizeNativeTools([
      {
        name: "select_items",
        description: "Select items",
        parameters: { items: { type: "string" } },
      },
    ]) as Record<string, { inputSchema: unknown }>;

    expect(tools.select_items.inputSchema).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("forwards toolChoice when tools are present", async () => {
    generateTextMock.mockResolvedValue({
      text: "",
      toolCalls: [],
      finishReason: "stop",
      usage: undefined,
    });

    await handleTextSmall(createRuntime(), {
      prompt: "p",
      tools: { lookup: { description: "L", inputSchema: { type: "object" } } },
      toolChoice: "required",
    } as never);

    const callArg = generateTextMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.toolChoice).toBe("required");
  });

  it("omits structured output when tools and responseSchema are both set", async () => {
    generateTextMock.mockResolvedValue({
      text: "tool-only",
      toolCalls: [],
      finishReason: "stop",
      usage: undefined,
    });

    await handleTextSmall(createRuntime(), {
      prompt: "p",
      tools: { lookup: { description: "L", inputSchema: { type: "object" } } },
      responseSchema: {
        type: "object",
        properties: { foo: { type: "string" } },
        required: [],
      },
    } as never);

    const callArg = generateTextMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.output).toBeUndefined();
    expect(callArg.tools).toBeDefined();
  });

  it("uses messages path and returns native-shaped result without tools or schema", async () => {
    generateTextMock.mockResolvedValue({
      text: "hello",
      toolCalls: [],
      finishReason: "stop",
      usage: undefined,
    });

    const result = await handleTextSmall(createRuntime(), {
      messages: [{ role: "user", content: "hi" }],
    } as never);
    expectGenerateTextResult(result);

    const callArg = generateTextMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(callArg.prompt).toBeUndefined();
    expect(result.text).toBe("hello");
    expect(result.toolCalls).toEqual([]);
  });

  it("omits stopSequences when the array is empty", async () => {
    generateTextMock.mockResolvedValue({
      text: "ok",
      finishReason: "stop",
      usage: undefined,
    });

    await handleTextSmall(createRuntime(), {
      prompt: "p",
      stopSequences: [],
    } as never);

    const callArg = generateTextMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.stopSequences).toBeUndefined();
  });

  it("does not throw when stream=true with responseSchema (nested useModel under chat streaming context)", async () => {
    generateTextMock.mockResolvedValue({
      text: "",
      output: { durable: [], current: [] },
      finishReason: "stop",
      usage: undefined,
    });

    const out = await handleTextSmall(createRuntime(), {
      prompt: "extract facts",
      stream: true,
      responseSchema: {
        type: "object",
        properties: { durable: { type: "array" }, current: { type: "array" } },
        required: ["durable", "current"],
      },
    } as never);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out)).toEqual({ durable: [], current: [] });
  });

  it("stream=true with toolChoice but no tools uses generateText (streamText requires a ToolSet)", async () => {
    generateTextMock.mockResolvedValue({
      text: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: undefined,
    });

    await handleTextSmall(createRuntime(), {
      prompt: "p",
      stream: true,
      toolChoice: "required",
    } as never);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("uses streamText when stream=true with tools and toolChoice (TEXT_SMALL forwards chunks)", async () => {
    streamTextMock.mockImplementation(() => ({
      textStream: (async function* () {
        yield "hello";
      })(),
      text: Promise.resolve("hello"),
      toolCalls: Promise.resolve([{ toolCallId: "c1", toolName: "lookup", input: { q: "x" } }]),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve("stop"),
    }));

    const result = await handleTextSmall(createRuntime(), {
      prompt: "p",
      stream: true,
      tools: { lookup: { description: "L", inputSchema: { type: "object" } } },
      toolChoice: "required",
    } as never);

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).not.toHaveBeenCalled();
    const stream = result as TextStreamResult & { toolCalls?: Promise<unknown[]> };
    const chunks: string[] = [];
    for await (const c of stream.textStream) {
      chunks.push(c);
    }
    expect(chunks).toEqual(["hello"]);
    await expect(stream.text).resolves.toBe("hello");
    await expect(stream.toolCalls).resolves.toEqual([
      { id: "c1", name: "lookup", arguments: { q: "x" } },
    ]);
  });

  it("stream=true + tools (RESPONSE_HANDLER): drains textStream, yields plan JSON chunk, text promise matches", async () => {
    const plan = {
      processMessage: "REPLY",
      plan: { contexts: ["simple"], reply: "hi" },
      thought: "",
    };
    streamTextMock.mockImplementation(() => ({
      textStream: (async function* () {
        yield "ignored-delta";
      })(),
      text: Promise.resolve(""),
      toolCalls: Promise.resolve([
        {
          toolCallId: "mh",
          toolName: "MESSAGE_HANDLER_PLAN",
          input: plan,
        },
      ]),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 2 }),
      finishReason: Promise.resolve("stop"),
    }));

    const result = await handleResponseHandler(createRuntime(), {
      prompt: "p",
      stream: true,
      tools: { MESSAGE_HANDLER_PLAN: { description: "D", inputSchema: { type: "object" } } },
      toolChoice: "required",
    } as never);

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).not.toHaveBeenCalled();
    const stream = result as TextStreamResult & { toolCalls?: Promise<unknown[]> };
    const chunks: string[] = [];
    for await (const c of stream.textStream) {
      chunks.push(c);
    }
    expect(chunks).toEqual([JSON.stringify(plan)]);
    await expect(stream.text).resolves.toBe(JSON.stringify(plan));
  });

  it("stream=true + tools + responseSchema uses streamText (tools win, no output on wire)", async () => {
    streamTextMock.mockImplementation(() => ({
      textStream: (async function* () {
        yield "x";
      })(),
      text: Promise.resolve("x"),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve("stop"),
    }));

    await handleTextLarge(createRuntime(), {
      prompt: "p",
      stream: true,
      tools: { lookup: { description: "L", inputSchema: { type: "object" } } },
      responseSchema: {
        type: "object",
        properties: { foo: { type: "string" } },
        required: [],
      },
    } as never);

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).not.toHaveBeenCalled();
    const callArg = streamTextMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.output).toBeUndefined();
    expect(callArg.tools).toBeDefined();
  });

  it("uses streamText and returns TextStreamResult when stream=true without schema or tools", async () => {
    streamTextMock.mockImplementation(() => ({
      textStream: (async function* () {
        yield "a";
        yield "b";
      })(),
      text: Promise.resolve("ab"),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
      finishReason: Promise.resolve("stop"),
    }));

    const result = await handleTextSmall(createRuntime(), {
      prompt: "hello",
      stream: true,
    } as never);

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(result && typeof result === "object" && "textStream" in result).toBe(true);
    const stream = result as TextStreamResult;
    const chunks: string[] = [];
    for await (const c of stream.textStream) {
      chunks.push(c);
    }
    expect(chunks).toEqual(["a", "b"]);
    await expect(stream.text).resolves.toBe("ab");
  });

  it("handles rejected stream promises when plain textStream fails before callers await usage", async () => {
    streamTextMock.mockImplementation(() => ({
      textStream: createFailingTextStream("stream failed"),
      text: Promise.reject(new Error("text failed")),
      usage: Promise.reject(new Error("usage failed")),
      finishReason: Promise.reject(new Error("finish failed")),
    }));

    const result = await handleTextSmall(createRuntime(), {
      prompt: "hello",
      stream: true,
    } as never);

    const stream = result as TextStreamResult;
    await expect(
      (async () => {
        for await (const _ of stream.textStream) {
          // consume until the mocked stream fails
        }
      })()
    ).rejects.toThrow("stream failed");
  });

  it("handles rejected toolCalls and usage promises when planner textStream fails", async () => {
    streamTextMock.mockImplementation(() => ({
      textStream: createFailingTextStream("planner stream failed"),
      text: Promise.reject(new Error("text failed")),
      toolCalls: Promise.reject(new Error("tool calls failed")),
      usage: Promise.reject(new Error("usage failed")),
      finishReason: Promise.reject(new Error("finish failed")),
    }));

    const result = await handleResponseHandler(createRuntime(), {
      prompt: "p",
      stream: true,
      tools: { MESSAGE_HANDLER_PLAN: { description: "D", inputSchema: { type: "object" } } },
      toolChoice: "required",
    } as never);

    const stream = result as TextStreamResult;
    await expect(
      (async () => {
        for await (const _ of stream.textStream) {
          // consume until the mocked stream fails
        }
      })()
    ).rejects.toThrow("planner stream failed");
  });
});
