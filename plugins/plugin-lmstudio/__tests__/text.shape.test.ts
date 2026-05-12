import type { GenerateTextResult, IAgentRuntime, TextStreamResult } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateTextMock, streamTextMock, createOpenAICompatibleMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  streamTextMock: vi.fn(),
  createOpenAICompatibleMock: vi.fn(),
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

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: (options: unknown) => createOpenAICompatibleMock(options),
}));

vi.mock("../utils/detect", () => ({
  detectLMStudio: vi.fn(async () => ({
    available: true,
    baseURL: "http://localhost:1234/v1",
    models: [{ id: "auto-detected-model" }],
  })),
}));

import {
  handleResponseHandler,
  handleTextLarge,
  handleTextSmall,
  normalizeNativeTools,
} from "../models/text";

function createRuntime(overrides: Record<string, string> = {}): IAgentRuntime {
  const settings: Record<string, string> = {
    LMSTUDIO_SMALL_MODEL: "manual-small",
    LMSTUDIO_LARGE_MODEL: "manual-large",
    ...overrides,
  };
  const runtime = {
    character: { system: "system prompt" },
    emitEvent: vi.fn(),
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  };
  return runtime as IAgentRuntime;
}

function expectGenerateTextResult(value: unknown): asserts value is GenerateTextResult {
  expect(value).toEqual(expect.objectContaining({ text: expect.any(String) }));
}

describe("LM Studio text plumbing shape", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() => ({
      textStream: (async function* () {})(),
      text: Promise.resolve(""),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve(undefined),
    }));
    createOpenAICompatibleMock.mockReset();
    createOpenAICompatibleMock.mockImplementation(() => {
      const provider = vi.fn((modelId: string) => ({ modelId }));
      return Object.assign(provider, {
        languageModel: vi.fn((modelId: string) => ({ modelId })),
        chatModel: vi.fn((modelId: string) => ({ modelId })),
        completionModel: vi.fn((modelId: string) => ({ modelId })),
        embeddingModel: vi.fn((modelId: string) => ({ modelId })),
        textEmbeddingModel: vi.fn((modelId: string) => ({ modelId })),
        imageModel: vi.fn((modelId: string) => ({ modelId })),
      });
    });
  });

  it("instantiates the OpenAI-compatible client with LM Studio's name and base URL", async () => {
    generateTextMock.mockResolvedValue({
      text: "ack",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 8 },
    });

    await handleTextSmall(createRuntime(), { prompt: "hi" } as never);

    expect(createOpenAICompatibleMock).toHaveBeenCalledTimes(1);
    const opts = createOpenAICompatibleMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.name).toBe("lmstudio");
    expect(opts.baseURL).toBe("http://localhost:1234/v1");
    expect(opts.apiKey).toBeUndefined();
  });

  it("forwards apiKey as bearer when configured", async () => {
    generateTextMock.mockResolvedValue({
      text: "",
      toolCalls: [],
      finishReason: "stop",
      usage: undefined,
    });

    await handleTextSmall(createRuntime({ LMSTUDIO_API_KEY: "sk-lm" }), {
      prompt: "hi",
    } as never);

    const opts = createOpenAICompatibleMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.apiKey).toBe("sk-lm");
  });

  it("uses LMSTUDIO_LARGE_MODEL for TEXT_LARGE", async () => {
    generateTextMock.mockResolvedValue({
      text: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: undefined,
    });

    await handleTextLarge(createRuntime(), { prompt: "p" } as never);
    const args = generateTextMock.mock.calls[0][0] as { model: { modelId: string } };
    expect(args.model.modelId).toBe("manual-large");
  });

  it("uses LMSTUDIO_SMALL_MODEL for TEXT_SMALL", async () => {
    generateTextMock.mockResolvedValue({
      text: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: undefined,
    });

    await handleTextSmall(createRuntime(), { prompt: "p" } as never);
    const args = generateTextMock.mock.calls[0][0] as { model: { modelId: string } };
    expect(args.model.modelId).toBe("manual-small");
  });

  it("falls back to the first /v1/models entry when no override is set", async () => {
    generateTextMock.mockResolvedValue({
      text: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: undefined,
    });

    const runtime = createRuntime();
    (runtime.getSetting as ReturnType<typeof vi.fn>).mockImplementation(() => null);

    await handleTextSmall(runtime, { prompt: "p" } as never);
    const args = generateTextMock.mock.calls[0][0] as { model: { modelId: string } };
    expect(args.model.modelId).toBe("auto-detected-model");
  });

  it("forwards native tools to generateText and returns a GenerateTextResult shape", async () => {
    generateTextMock.mockResolvedValue({
      text: "ack",
      toolCalls: [{ toolCallId: "c1", toolName: "lookup", input: { q: "x" } }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2 },
    });

    const result = await handleTextSmall(createRuntime(), {
      prompt: "use a tool",
      tools: { lookup: { description: "Lookup", inputSchema: { type: "object" } } },
    } as never);

    expectGenerateTextResult(result);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("ack");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({
      id: "c1",
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
      responseSchema: { type: "object", properties: {} },
    } as never);

    const callArg = generateTextMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.output).toBeUndefined();
    expect(callArg.tools).toBeDefined();
  });

  it("uses streamText when stream=true without schema or tools", async () => {
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
    const stream = result as TextStreamResult;
    const chunks: string[] = [];
    for await (const c of stream.textStream) {
      chunks.push(c);
    }
    expect(chunks).toEqual(["a", "b"]);
    await expect(stream.text).resolves.toBe("ab");
  });

  it("falls back to generateText when stream=true with structured output", async () => {
    generateTextMock.mockResolvedValue({
      text: "",
      output: { foo: "bar" },
      finishReason: "stop",
      usage: undefined,
    });

    const out = await handleTextSmall(createRuntime(), {
      prompt: "p",
      stream: true,
      responseSchema: { type: "object", properties: { foo: { type: "string" } } },
    } as never);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out as string)).toEqual({ foo: "bar" });
  });

  it("returns an error string when generateText throws (resilience)", async () => {
    generateTextMock.mockRejectedValue(
      Object.assign(new Error("loaded model is unavailable"), {
        statusCode: 500,
        responseBody: '{"error":"no model loaded"}',
        url: "http://localhost:1234/v1/chat/completions",
      })
    );

    const result = await handleResponseHandler(createRuntime(), { prompt: "p" } as never);
    expect(typeof result).toBe("string");
    expect(result).toMatch(/Error generating text/i);
  });
});
