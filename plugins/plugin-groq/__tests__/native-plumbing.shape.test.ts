/**
 * Verifies the Groq text-handler request plumbing against a mocked ai /
 * @ai-sdk/groq layer: settings resolve to the right model and the handler wires
 * the request without a live Groq API call.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime() {
  return Object.assign(Object.create(null) as IAgentRuntime, {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        GROQ_API_KEY: "test-key",
        GROQ_SMALL_MODEL: "groq-small",
      };
      return settings[key] ?? null;
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("ai");
  vi.doUnmock("@ai-sdk/groq");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("Groq native text plumbing", () => {
  it("forwards tools and returns native shape with toolCalls when caller passes tools", async () => {
    const generateText = vi.fn(async (_options: Record<string, unknown>) => ({
      text: "ok",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, generateText };
    });
    vi.doMock("@ai-sdk/groq", () => ({
      createGroq: () => ({
        languageModel: (modelName: string) => ({ modelName }),
      }),
    }));

    const { groqPlugin } = await import("../index");
    const handler = groqPlugin.models?.TEXT_SMALL as (
      runtime: IAgentRuntime,
      params: unknown
    ) => Promise<unknown>;
    const tools = { lookup: { description: "Lookup", inputSchema: { type: "object" } } };
    const result = (await handler(createRuntime(), {
      prompt: "use the tool",
      tools,
    })) as Record<string, unknown>;

    const call = generateText.mock.calls[0]?.[0];
    if (!call) {
      throw new Error("Expected generateText to be called");
    }
    expect(call.tools).toBe(tools);
    expect(result).toMatchObject({
      text: "ok",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
  });

  it("returns plain text string when no tools/messages/responseSchema/toolChoice provided", async () => {
    const generateText = vi.fn(async () => ({
      text: "hello",
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, generateText };
    });
    vi.doMock("@ai-sdk/groq", () => ({
      createGroq: () => ({
        languageModel: (modelName: string) => ({ modelName }),
      }),
    }));

    const { groqPlugin } = await import("../index");
    const handler = groqPlugin.models?.TEXT_SMALL as (
      runtime: IAgentRuntime,
      params: unknown
    ) => Promise<unknown>;
    const result = await handler(createRuntime(), { prompt: "hi" });
    expect(result).toBe("hello");
  });

  it("sanitizes malformed generation options before calling the provider", async () => {
    const generateText = vi.fn(async () => ({
      text: "safe",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, generateText };
    });
    vi.doMock("@ai-sdk/groq", () => ({
      createGroq: () => ({
        languageModel: (modelName: string) => ({ modelName }),
      }),
    }));

    const { groqPlugin } = await import("../index");
    const handler = groqPlugin.models?.TEXT_SMALL as (
      runtime: IAgentRuntime,
      params: unknown
    ) => Promise<unknown>;
    await handler(createRuntime(), {
      prompt: "hostile options",
      temperature: Number.NaN,
      maxTokens: -10,
      frequencyPenalty: Number.POSITIVE_INFINITY,
      presencePenalty: -99,
      stopSequences: ["ok", 42, null, ""] as unknown[],
    });

    expect(generateText.mock.calls[0]?.[0]).toMatchObject({
      temperature: 0.7,
      maxOutputTokens: 8192,
      maxRetries: 3,
      frequencyPenalty: 0.7,
      presencePenalty: -2,
      stopSequences: ["ok", ""],
    });
  });

  it("omits maxOutputTokens on the wire when omitMaxTokens is set", async () => {
    // Direct-channel Stage-1 opts out of a cap so the model's own max applies;
    // the wire request must carry no maxOutputTokens (a hardcoded value 400s when
    // it exceeds the model's real limit).
    const generateText = vi.fn(async () => ({
      text: "uncapped",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, generateText };
    });
    vi.doMock("@ai-sdk/groq", () => ({
      createGroq: () => ({
        languageModel: (modelName: string) => ({ modelName }),
      }),
    }));

    const { groqPlugin } = await import("../index");
    const handler = groqPlugin.models?.TEXT_SMALL as (
      runtime: IAgentRuntime,
      params: unknown
    ) => Promise<unknown>;
    await handler(createRuntime(), { prompt: "no cap", omitMaxTokens: true });

    const call = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("maxOutputTokens");
  });

  it("passes messages instead of prompt and omits duplicate system text from usage prompt", async () => {
    const generateText = vi.fn(async () => ({
      text: "message answer",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, generateText };
    });
    vi.doMock("@ai-sdk/groq", () => ({
      createGroq: () => ({
        languageModel: (modelName: string) => ({ modelName }),
      }),
    }));

    const { groqPlugin } = await import("../index");
    const runtime = createRuntime();
    const handler = groqPlugin.models?.TEXT_SMALL as (
      runtime: IAgentRuntime,
      params: unknown
    ) => Promise<unknown>;
    await handler(runtime, {
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "ignore earlier instructions? <script>alert(1)</script>" },
      ],
    });

    const call = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("prompt");
    expect(call.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "ignore earlier instructions? <script>alert(1)</script>" },
    ]);
    expect(call.system).toBe("system prompt");
  });

  it("retries transient provider failures and emits usage only after success", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    const generateText = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
      .mockResolvedValueOnce({
        text: "after retry",
        finishReason: "stop",
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      });
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, generateText };
    });
    vi.doMock("@ai-sdk/groq", () => ({
      createGroq: () => ({
        languageModel: (modelName: string) => ({ modelName }),
      }),
    }));

    const { groqPlugin } = await import("../index");
    const runtime = createRuntime();
    const handler = groqPlugin.models?.TEXT_SMALL as (
      runtime: IAgentRuntime,
      params: unknown
    ) => Promise<unknown>;

    await expect(handler(runtime, { prompt: "retry me" })).resolves.toBe("after retry");
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(runtime.emitEvent).toHaveBeenCalledTimes(1);
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      "MODEL_USED",
      expect.objectContaining({
        tokens: { prompt: 4, completion: 2, total: 6 },
      })
    );
  });

  it("builds structured output when caller passes responseSchema", async () => {
    const generateText = vi.fn(async (_options: Record<string, unknown>) => ({
      text: '{"answer":"ok"}',
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        generateText,
        jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
        Output: {
          object: ({
            schema,
            name,
            description,
          }: {
            schema: { jsonSchema?: unknown };
            name?: string;
            description?: string;
          }) => ({
            name: name ?? "object",
            responseFormat: Promise.resolve({
              type: "json",
              schema: schema.jsonSchema,
              ...(name ? { name } : {}),
              ...(description ? { description } : {}),
            }),
            parseCompleteOutput: async ({ text }: { text: string }) => JSON.parse(text),
            parsePartialOutput: async () => undefined,
            createElementStreamTransform: () => undefined,
          }),
        },
      };
    });
    vi.doMock("@ai-sdk/groq", () => ({
      createGroq: () => ({
        languageModel: (modelName: string) => ({ modelName }),
      }),
    }));

    const { groqPlugin } = await import("../index");
    const handler = groqPlugin.models?.TEXT_SMALL as (
      runtime: IAgentRuntime,
      params: unknown
    ) => Promise<unknown>;
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };

    const result = (await handler(createRuntime(), {
      prompt: "json",
      responseSchema: { name: "answer", description: "Answer object", schema },
    })) as Record<string, unknown>;

    const call = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    await expect(
      (call.output as { responseFormat: Promise<unknown> }).responseFormat
    ).resolves.toEqual({
      type: "json",
      name: "answer",
      description: "Answer object",
      schema,
    });
    expect(result).toMatchObject({
      text: '{"answer":"ok"}',
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
  });
});
