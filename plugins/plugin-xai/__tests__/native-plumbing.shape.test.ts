import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleTextEmbedding,
  handleTextSmall,
  isGrokConfigured,
} from "../models/grok";

function createRuntime(overrides: Record<string, string> = {}) {
  return {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        XAI_API_KEY: "test-key",
        XAI_SMALL_MODEL: "grok-test-small",
        XAI_EMBEDDING_MODEL: "grok-embed-test",
        ...overrides,
      };
      return settings[key] ?? null;
    }),
  } as IAgentRuntime;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("xAI native text plumbing", () => {
  it("accepts GROK_API_KEY as the documented auto-enable alias", async () => {
    const runtime = createRuntime({
      XAI_API_KEY: "",
      GROK_API_KEY: "grok-key",
    });
    expect(isGrokConfigured(runtime)).toBe(true);

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "x",
            object: "chat.completion",
            created: 0,
            model: "grok-test-small",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hello" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(handleTextSmall(runtime, { prompt: "hi" })).resolves.toBe(
      "hello",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer grok-key",
    });
  });

  it("forwards tools and returns native shape with toolCalls when caller passes tools", {
    timeout: 15000,
  }, async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "x",
            object: "chat.completion",
            created: 0,
            model: "grok-test-small",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "lookup", arguments: '{"q":"x"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const tools = {
      lookup: { description: "Lookup", inputSchema: { type: "object" } },
    };
    const result = (await handleTextSmall(createRuntime(), {
      prompt: "use the tool",
      tools,
    } as never)) as Record<string, unknown>;

    const requestBody = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(Array.isArray(requestBody.tools)).toBe(true);
    expect((requestBody.tools as Array<Record<string, unknown>>)[0]?.type).toBe(
      "function",
    );
    expect(result).toMatchObject({
      text: "",
      finishReason: "tool_calls",
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
    expect((result.toolCalls as unknown[]).length).toBe(1);
    expect(
      (result.toolCalls as Array<Record<string, unknown>>)[0],
    ).toMatchObject({
      toolCallId: "call_1",
      toolName: "lookup",
      input: { q: "x" },
    });
  });

  it("returns plain text string when no tools/messages/responseSchema/toolChoice provided", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "x",
            object: "chat.completion",
            created: 0,
            model: "grok-test-small",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hello" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const result = await handleTextSmall(createRuntime(), { prompt: "hi" });
    expect(result).toBe("hello");
  });

  it("sends responseSchema as strict json_schema and returns native result shape", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "x",
            object: "chat.completion",
            created: 0,
            model: "grok-test-small",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: '{"ok":true}' },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const result = (await handleTextSmall(createRuntime(), {
      prompt: "json",
      responseSchema: {
        name: "answer",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    } as never)) as Record<string, unknown>;

    const requestBody = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(requestBody.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "answer",
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    });
    expect(result).toMatchObject({
      text: '{"ok":true}',
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    });
  });

  it("returns a TextStreamResult and buffers split SSE lines", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"model":"grok-test-small","choices":[{"delta":{"content":"hel',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);
    const onStreamChunk = vi.fn();

    const result = await handleTextSmall(createRuntime(), {
      prompt: "hi",
      stream: true,
      onStreamChunk,
    });

    expect(typeof result).toBe("object");
    const streamResult = result as Exclude<typeof result, string>;
    expect(await streamResult.text).toBe("hello!");
    const chunks: string[] = [];
    for await (const chunk of streamResult.textStream) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["hello", "!"]);
    expect(onStreamChunk).toHaveBeenNthCalledWith(1, "hello");
    expect(onStreamChunk).toHaveBeenNthCalledWith(2, "!");
    expect(await streamResult.usage).toEqual({
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
    });
    expect(await streamResult.finishReason).toBe("stop");

    const requestBody = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(requestBody.stream).toBe(true);
  });

  it("rejects whitespace-only embeddings before fetch", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(handleTextEmbedding(createRuntime(), "   ")).rejects.toThrow(
      "Empty text provided for embedding",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates embeddings and emits usage", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
            model: "grok-embed-test",
            usage: { prompt_tokens: 4, total_tokens: 4 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);
    const runtime = createRuntime();

    await expect(
      handleTextEmbedding(runtime, { text: "hello" }),
    ).resolves.toEqual([0.1, 0.2]);
    const requestBody = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(requestBody).toEqual({ model: "grok-embed-test", input: "hello" });
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: "TEXT_EMBEDDING",
        modelName: "grok-embed-test",
        tokens: { prompt: 4, completion: 0, total: 4 },
      }),
    );
  });
});
