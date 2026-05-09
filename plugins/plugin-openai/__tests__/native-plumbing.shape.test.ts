import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

// `getSetting` in utils/config falls back to `process.env` when the runtime
// stub returns undefined. The repo-root `.env` is auto-loaded by bun (and
// re-injected on dynamic import), so a developer or CI environment with
// `OPENAI_BASE_URL=https://api.cerebras.ai/v1` or `OPENAI_SMALL_MODEL=...`
// flips the Cerebras codepath / overrides the model default. We use
// `vi.stubEnv` to pin env vars deterministically — vitest restores them
// in `vi.unstubAllEnvs`, and the stubs survive bun's dotenv re-injection.
//
// `OPENAI_BASE_URL` is pinned to a non-Cerebras URL (rather than empty)
// because empty strings short-circuit `getSetting` to `""`, which is not
// the same as "unset" for downstream callers.
const ENV_KEYS_TO_CLEAR = [
  "MILADY_PROVIDER",
  "CEREBRAS_API_KEY",
  "OPENAI_SMALL_MODEL",
  "SMALL_MODEL",
  "OPENAI_LARGE_MODEL",
  "LARGE_MODEL",
  "OPENAI_RESPONSE_HANDLER_MODEL",
  "OPENAI_SHOULD_RESPOND_MODEL",
  "RESPONSE_HANDLER_MODEL",
  "SHOULD_RESPOND_MODEL",
] as const;

beforeEach(() => {
  vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  for (const key of ENV_KEYS_TO_CLEAR) {
    vi.stubEnv(key, undefined as unknown as string);
  }
});

vi.mock("ai", () => ({
  generateText: aiMocks.generateText,
  streamText: aiMocks.streamText,
  jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
  Output: {
    object: ({
      schema,
      name,
      description,
    }: {
      schema: unknown;
      name?: string;
      description?: string;
    }) => ({
      name: "object",
      responseFormat: Promise.resolve({
        type: "json",
        schema: (schema as { jsonSchema?: unknown }).jsonSchema ?? schema,
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
      }),
      parseCompleteOutput: async ({ text }: { text: string }) => JSON.parse(text),
      parsePartialOutput: async () => undefined,
      createElementStreamTransform: () => undefined,
    }),
  },
}));

vi.mock("../providers", () => ({
  createOpenAIClient: () => ({
    chat: (modelName: string) => ({ modelName }),
  }),
}));

function createRuntime() {
  const runtime = {
    character: { name: "Ada", system: "system prompt" },
    emitEvent: vi.fn(),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        OPENAI_API_KEY: "test-key",
        OPENAI_SMALL_MODEL: "gpt-test-small",
      };
      return settings[key];
    }),
  };

  return runtime as IAgentRuntime;
}

function expectNativeTextResult(value: unknown): asserts value is Record<string, unknown> {
  expect(value).toEqual(expect.objectContaining({ text: expect.any(String) }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("OpenAI native text plumbing", () => {
  it("passes messages, tools, toolChoice, schema, and provider options through", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: "ok",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 5 },
    });

    const { handleTextSmall } = await import("../models/text");
    const messages = [{ role: "user", content: "use the tool" }];
    const tools = { lookup: { description: "Lookup", inputSchema: { type: "object" } } };
    const toolChoice = { type: "tool", toolName: "lookup" };
    const responseSchema = { type: "object", properties: { answer: { type: "string" } } };

    const result = await handleTextSmall(createRuntime(), {
      prompt: "legacy prompt",
      messages,
      tools,
      toolChoice,
      responseSchema,
      providerOptions: {
        agentName: "Ada",
        openai: { promptCacheKey: "cache-key", promptCacheRetention: "24h" },
        custom: { enabled: true },
      },
    } as never);
    expectNativeTextResult(result);

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.messages).toEqual(messages);
    expect(call).not.toHaveProperty("prompt");
    expect(call.tools).toBe(tools);
    expect(call.toolChoice).toBe(toolChoice);
    expect(call.providerOptions).toEqual({
      custom: { enabled: true },
      openai: { promptCacheKey: "cache-key", promptCacheRetention: "24h" },
    });
    expect(call.experimental_telemetry).toMatchObject({
      functionId: "agent:Ada",
      metadata: { agentName: "Ada" },
    });
    await expect(
      (call.output as { responseFormat: Promise<unknown> }).responseFormat
    ).resolves.toEqual({
      type: "json",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    });
    expect(result).toMatchObject({
      text: "ok",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: {
        promptTokens: 7,
        completionTokens: 3,
        totalTokens: 10,
        cachedPromptTokens: 5,
        cacheReadInputTokens: 5,
      },
    });
  }, 180_000);

  it("preserves Cerebras cache keys while stripping OpenAI-only cache retention", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 1 },
    });

    const runtime = createRuntime();
    vi.mocked(runtime.getSetting).mockImplementation((key: string) => {
      const settings: Record<string, string> = {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
        OPENAI_SMALL_MODEL: "gpt-oss-120b",
      };
      return settings[key];
    });

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(runtime, {
      prompt: "cache",
      providerOptions: {
        openai: { promptCacheKey: "v5:abc", promptCacheRetention: "24h" },
        cerebras: { promptCacheKey: "v5:abc", prompt_cache_key: "v5:abc" },
        gateway: { caching: "auto" },
      },
    } as never);

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.providerOptions).toEqual({
      cerebras: { promptCacheKey: "v5:abc", prompt_cache_key: "v5:abc" },
      gateway: { caching: "auto" },
      openai: { promptCacheKey: "v5:abc" },
    });
  });

  it("defaults small and response handler models to gpt-5.4-mini while preserving explicit overrides", async () => {
    const { getResponseHandlerModel, getSmallModel } = await import("../utils/config");
    const runtime = {
      getSetting: vi.fn(() => undefined),
    } as IAgentRuntime;

    expect(getSmallModel(runtime)).toBe("gpt-5.4-mini");
    expect(getResponseHandlerModel(runtime)).toBe("gpt-5.4-mini");

    const overrideRuntime = {
      getSetting: vi.fn((key: string) => {
        const settings: Record<string, string> = {
          OPENAI_SMALL_MODEL: "custom-small",
          OPENAI_RESPONSE_HANDLER_MODEL: "custom-response",
        };
        return settings[key];
      }),
    } as IAgentRuntime;
    expect(getSmallModel(overrideRuntime)).toBe("custom-small");
    expect(getResponseHandlerModel(overrideRuntime)).toBe("custom-response");
  });

  it("passes the effective system separately without duplicating the leading system message", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 1 },
    });

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(createRuntime(), {
      prompt: "legacy prompt",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "hello" },
      ],
    } as never);

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.system).toBe("system prompt");
    expect(call.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("normalizes core tool arrays and tool choice into AI SDK tool sets", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: "",
      toolCalls: [{ toolName: "WEB_SEARCH", input: { q: "eliza" } }],
      finishReason: "tool-calls",
      usage: { inputTokens: 11, outputTokens: 2 },
    });

    const { handleTextSmall } = await import("../models/text");
    const coreTools = [
      {
        name: "WEB_SEARCH",
        description: "Search the web",
        type: "function",
        strict: true,
        parameters: {
          properties: {
            q: { description: "Query", type: "string" },
          },
          required: ["q"],
          additionalProperties: false,
        },
      },
    ];

    await handleTextSmall(createRuntime(), {
      prompt: "use native tool",
      messages: [{ role: "user", content: "search eliza" }],
      tools: coreTools,
      toolChoice: { type: "tool", name: "WEB_SEARCH" },
    } as never);

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.tools).not.toBe(coreTools);
    expect(Object.keys(call.tools as Record<string, unknown>)).toEqual(["WEB_SEARCH"]);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "WEB_SEARCH" });

    const webSearch = (call.tools as Record<string, { inputSchema: { jsonSchema: unknown } }>)
      .WEB_SEARCH;
    expect(webSearch.inputSchema.jsonSchema).toEqual({
      type: "object",
      properties: {
        q: { description: "Query", type: "string" },
      },
      required: ["q"],
      additionalProperties: false,
    });
  }, 60_000);

  it("normalizes core assistant/tool history into AI SDK model messages", async () => {
    aiMocks.generateText.mockResolvedValue({
      text: JSON.stringify({ decision: "FINISH", success: true }),
      finishReason: "stop",
      usage: { inputTokens: 17, outputTokens: 4 },
    });

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(createRuntime(), {
      prompt: "evaluate",
      messages: [
        { role: "user", content: "search eliza" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "tool-1",
              type: "function",
              name: "WEB_SEARCH",
              arguments: JSON.stringify({ q: "eliza" }),
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "tool-1",
          name: "WEB_SEARCH",
          content: JSON.stringify({ success: true, text: "found results" }),
        },
      ],
    } as never);

    const call = aiMocks.generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.messages).toEqual([
      { role: "user", content: "search eliza" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "WEB_SEARCH",
            input: { q: "eliza" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tool-1",
            toolName: "WEB_SEARCH",
            output: { type: "json", value: { success: true, text: "found results" } },
          },
        ],
      },
    ]);
  }, 60_000);
});
