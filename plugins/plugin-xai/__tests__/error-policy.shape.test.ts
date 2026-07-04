/**
 * Failure-path tests for the #12182 error-handling policy (#12795): missing
 * credential, provider 4xx/5xx and rate-limit rejections, malformed responses,
 * and empty-completion fabrication for the xAI handlers, which call the REST
 * API through a stubbed `runtime.fetch` — no live API. Every failure must
 * surface as a typed error — never a fabricated "" completion, empty native
 * result, or success MODEL_USED event.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTextEmbedding, handleTextSmall } from "../models/grok";

function createRuntime(
  fetchImpl: typeof fetch | undefined,
  settings: Record<string, string | null> = {},
): IAgentRuntime {
  const defaults: Record<string, string> = { XAI_API_KEY: "test-key" };
  return {
    character: { name: "Grokky", system: "character system prompt" },
    emitEvent: vi.fn(async () => undefined),
    fetch: fetchImpl,
    getSetting: vi.fn((key: string) =>
      key in settings ? settings[key] : (defaults[key] ?? null),
    ),
  } as unknown as IAgentRuntime;
}

function chatCompletion(
  content: string | null,
  options?: {
    finishReason?: string;
    toolCalls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  },
): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "grok-3-mini",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(options?.toolCalls ? { tool_calls: options.toolCalls } : {}),
          },
          finish_reason: options?.finishReason ?? "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function sseResponse(lines: string[]): Response {
  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const emitEventOf = (runtime: IAgentRuntime) =>
  (runtime as unknown as { emitEvent: ReturnType<typeof vi.fn> }).emitEvent;

afterEach(() => {
  vi.clearAllMocks();
});

describe("xAI credential and config failure surfaces", () => {
  it("throws a typed missing-credential error before any request", async () => {
    const fetchMock = vi.fn(async () => chatCompletion("hi"));
    const runtime = createRuntime(fetchMock as unknown as typeof fetch, {
      XAI_API_KEY: null,
      GROK_API_KEY: null,
    });

    await expect(handleTextSmall(runtime, { prompt: "hi" })).rejects.toThrow(
      "XAI_API_KEY is required",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a misconfigured XAI_BASE_URL with the original parse failure as cause", async () => {
    const runtime = createRuntime(undefined, { XAI_BASE_URL: "not a url" });

    const error = await handleTextSmall(runtime, { prompt: "hi" }).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as Error,
    );
    expect(error.message).toBe("XAI_BASE_URL must be a valid URL");
    expect(error.cause).toBeDefined();
  });
});

describe("xAI provider rejection surfaces", () => {
  it.each([
    [401, "Invalid API key"],
    [429, "rate limited"],
    [500, "internal error"],
  ])("surfaces a %d as a typed error without a usage event", async (status, message) => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: message }), { status }),
    );
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    await expect(handleTextSmall(runtime, { prompt: "hi" })).rejects.toThrow(
      `Grok API error (${status})`,
    );
    expect(emitEventOf(runtime)).not.toHaveBeenCalled();
  });

  it("surfaces a malformed (non-JSON) 200 response as a typed error", async () => {
    const fetchMock = vi.fn(
      async () => new Response("<html>oops</html>", { status: 200 }),
    );
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    await expect(handleTextSmall(runtime, { prompt: "hi" })).rejects.toThrow();
    expect(emitEventOf(runtime)).not.toHaveBeenCalled();
  });
});

describe("xAI empty-completion surfaces (throw, never fabricate)", () => {
  it("keeps the prompt-only empty-content failure typed (regression)", async () => {
    const fetchMock = vi.fn(async () =>
      chatCompletion(null, { finishReason: "stop" }),
    );
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    await expect(handleTextSmall(runtime, { prompt: "hi" })).rejects.toThrow(
      "No content in Grok response",
    );
    expect(emitEventOf(runtime)).not.toHaveBeenCalled();
  });

  it("throws MODEL_EMPTY_COMPLETION for a native call with no text and no tool calls", async () => {
    const fetchMock = vi.fn(async () =>
      chatCompletion(null, { finishReason: "stop" }),
    );
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    await expect(
      handleTextSmall(runtime, {
        prompt: "use the tool",
        tools: [{ name: "lookup", parameters: { type: "object" } }],
      } as never),
    ).rejects.toMatchObject({ code: "MODEL_EMPTY_COMPLETION" });
    expect(emitEventOf(runtime)).not.toHaveBeenCalled();
  });

  it("still succeeds for a tool-call-only native completion", async () => {
    const fetchMock = vi.fn(async () =>
      chatCompletion(null, {
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"q":1}' },
          },
        ],
      }),
    );
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    const result = (await handleTextSmall(runtime, {
      prompt: "use the tool",
      tools: [{ name: "lookup", parameters: { type: "object" } }],
    } as never)) as unknown as {
      text: string;
      toolCalls: Array<{ toolName: string }>;
    };

    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ toolName: "lookup", input: { q: 1 } }),
    ]);
    expect(emitEventOf(runtime)).toHaveBeenCalledTimes(1);
  });
});

describe("xAI stream failure surfaces", () => {
  it("throws MODEL_EMPTY_COMPLETION when the stream delivers zero content chunks", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["data: [DONE]", ""]));
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    const result = await handleTextSmall(runtime, {
      prompt: "hi",
      stream: true,
    } as never);
    const consume = async () => {
      for await (const _chunk of (
        result as { textStream: AsyncIterable<string> }
      ).textStream) {
        // drain
      }
    };
    await expect(consume()).rejects.toMatchObject({
      code: "MODEL_EMPTY_COMPLETION",
    });
    expect(emitEventOf(runtime)).not.toHaveBeenCalled();
  });

  it("keeps the stream success path intact: chunks delivered, usage emitted", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
        "data: [DONE]",
        "",
      ]),
    );
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    const result = (await handleTextSmall(runtime, {
      prompt: "hi",
      stream: true,
    } as never)) as unknown as {
      textStream: AsyncIterable<string>;
      text: Promise<string>;
      finishReason: Promise<string | undefined>;
    };
    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["hel", "lo"]);
    await expect(result.text).resolves.toBe("hello");
    await expect(result.finishReason).resolves.toBe("stop");
    expect(emitEventOf(runtime)).toHaveBeenCalledTimes(1);
  });
});

describe("xAI embedding failure surfaces", () => {
  it("surfaces a 429 as a typed error, never a fabricated vector", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
        }),
    );
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    await expect(handleTextEmbedding(runtime, "hello")).rejects.toThrow(
      "Grok Embedding API error (429)",
    );
    expect(emitEventOf(runtime)).not.toHaveBeenCalled();
  });

  it("surfaces a malformed embedding response (no vector) as a typed error", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ object: "list", data: [], model: "grok-embedding" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const runtime = createRuntime(fetchMock as unknown as typeof fetch);

    await expect(handleTextEmbedding(runtime, "hello")).rejects.toThrow(
      "No embedding in Grok response",
    );
  });
});
