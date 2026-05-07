import { ModelType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RuntimeSettings = Record<string, string | null | undefined>;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function createRuntime(settings: RuntimeSettings = {}, fetchImpl = vi.fn()) {
  return {
    character: { name: "Ada", system: "system prompt" },
    emitEvent: vi.fn(),
    fetch: fetchImpl,
    getSetting: vi.fn((key: string) => (key in settings ? settings[key] : null)),
  };
}

describe("@elizaos/plugin-cerebras", () => {
  beforeEach(() => {
    (vi as unknown as { resetModules?: () => void }).resetModules?.();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exports a standalone Cerebras plugin", async () => {
    const mod = await import("../index");

    expect(mod.default).toBe(mod.cerebrasPlugin);
    expect(mod.cerebrasPlugin.name).toBe("cerebras");
    expect(mod.cerebrasPlugin.config).toHaveProperty("CEREBRAS_API_KEY");
    expect(mod.cerebrasPlugin.models).toHaveProperty(ModelType.TEXT_SMALL);
    expect(mod.cerebrasPlugin.models).toHaveProperty(ModelType.ACTION_PLANNER);
    expect(mod.cerebrasPlugin.models).toHaveProperty(ModelType.OBJECT_SMALL);
  });

  it("posts OpenAI-compatible chat completions with native tools and structured output", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
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
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
          prompt_tokens_details: { cached_tokens: 6 },
        },
      })
    );
    const runtime = createRuntime(
      {
        CEREBRAS_API_KEY: "test-cerebras-key",
        CEREBRAS_BASE_URL: "https://example.test/v1",
        CEREBRAS_SMALL_MODEL: "llama3.1-8b",
      },
      fetchImpl
    );
    const { cerebrasPlugin } = await import("../index");

    const result = (await cerebrasPlugin.models?.[ModelType.TEXT_SMALL]?.(
      runtime as never,
      {
        prompt: "legacy prompt",
        messages: [{ role: "user", content: "use the tool" }],
        tools: [
          {
            name: "lookup",
            description: "Lookup",
            parameters: { type: "object", properties: { q: { type: "string" } } },
            strict: true,
          },
        ],
        toolChoice: { name: "lookup" },
        responseSchema: { type: "object", properties: { answer: { type: "string" } } },
        providerOptions: {
          cerebras: { promptCacheKey: "cache-key" },
        },
      } as never
    )) as unknown as Record<string, unknown>;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect(request.headers).toMatchObject({
      Authorization: "Bearer test-cerebras-key",
      "Content-Type": "application/json",
    });
    const payload = JSON.parse(request.body as string);
    expect(payload).toMatchObject({
      model: "llama3.1-8b",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "use the tool" },
      ],
      tool_choice: { type: "function", function: { name: "lookup" } },
      prompt_cache_key: "cache-key",
    });
    expect(payload.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object", properties: { q: { type: "string" } } },
          strict: true,
        },
      },
    ]);
    // Cerebras rejects requests that combine `tools` with `response_format`
    // (their grammar compiler can't run both at once). plugin-cerebras drops
    // response_format when tools are present — structured output flows back
    // through native tool_calls instead.
    expect(payload.response_format).toBeUndefined();
    expect(result).toMatchObject({
      text: "",
      toolCalls: [
        {
          id: "call_1",
          name: "lookup",
          arguments: '{"q":"x"}',
          type: "function",
          status: "pending",
        },
      ],
      finishReason: "tool_calls",
      usage: {
        promptTokens: 12,
        completionTokens: 4,
        totalTokens: 16,
        cachedPromptTokens: 6,
        cacheReadInputTokens: 6,
      },
    });
  });

  it("returns legacy text for prompt-only calls", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
    const runtime = createRuntime({ CEREBRAS_API_KEY: "test-cerebras-key" }, fetchImpl);
    const { cerebrasPlugin } = await import("../index");

    const result = await cerebrasPlugin.models?.[ModelType.TEXT_SMALL]?.(
      runtime as never,
      {
        prompt: "Say hello.",
      } as never
    );

    expect(result).toBe("hello");
  });

  it("uses custom msgpack payload hook without implementing serialization in the plugin", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      })
    );
    const encoded = new Uint8Array([1, 2, 3]);
    const encodePayload = vi.fn(() => encoded);
    const runtime = createRuntime({ CEREBRAS_API_KEY: "test-cerebras-key" }, fetchImpl);
    const { cerebrasPlugin } = await import("../index");

    await cerebrasPlugin.models?.[ModelType.TEXT_SMALL]?.(
      runtime as never,
      {
        prompt: "Encode me.",
        providerOptions: {
          cerebras: {
            payloadEncoding: "msgpack",
            encodePayload,
          },
        },
      } as never
    );

    expect(encodePayload).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-oss-120b" }));
    const request = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(request.body).toBe(encoded);
    expect(request.headers).toMatchObject({
      "Content-Type": "application/msgpack",
    });
  });

  it("sends response_format for structured output when no tools are present", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: '{"answer":"42"}' }, finish_reason: "stop" }],
      })
    );
    const runtime = createRuntime({ CEREBRAS_API_KEY: "k" }, fetchImpl);
    const { cerebrasPlugin } = await import("../index");

    await cerebrasPlugin.models?.[ModelType.TEXT_SMALL]?.(
      runtime as never,
      {
        prompt: "answer",
        messages: [{ role: "user", content: "what's 6*7?" }],
        responseSchema: { type: "object", properties: { answer: { type: "string" } } },
      } as never
    );

    const payload = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string
    );
    expect(payload.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "eliza_response", strict: true },
    });
    expect(payload.tools).toBeUndefined();
  });

  it("sanitizes dotted tool names for Cerebras's grammar compiler and rewrites response names", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "math_factorial", arguments: '{"n":5}' },
                },
                {
                  id: "c2",
                  type: "function",
                  function: { name: "algebra_quadratic_roots", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
    const runtime = createRuntime({ CEREBRAS_API_KEY: "test-cerebras-key" }, fetchImpl);
    const { cerebrasPlugin } = await import("../index");

    const result = (await cerebrasPlugin.models?.[ModelType.TEXT_SMALL]?.(
      runtime as never,
      {
        prompt: "ignored",
        messages: [{ role: "user", content: "use the tools" }],
        tools: [
          {
            name: "math.factorial",
            description: "factorial",
            parameters: { type: "object", properties: { n: { type: "integer" } } },
          },
          {
            name: "algebra.quadratic.roots",
            description: "roots",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never
    )) as unknown as { toolCalls: Array<{ name: string; id: string }> };

    const payload = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string
    );
    expect(payload.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual([
      "math_factorial",
      "algebra_quadratic_roots",
    ]);
    expect(result.toolCalls.map((tc) => tc.name)).toEqual([
      "math.factorial",
      "algebra.quadratic.roots",
    ]);
  });
});
