import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime() {
  return {
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
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  vi.doUnmock("ai");
  vi.doUnmock("../providers");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("OpenAI native text plumbing", () => {
  it("passes messages, tools, toolChoice, schema, and provider options through", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 5 },
    }));
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createOpenAIClient: () => ({
        chat: (modelName: string) => ({ modelName }),
      }),
    }));

    const { handleTextSmall } = await import("../models/text");
    const messages = [{ role: "user", content: "use the tool" }];
    const tools = { lookup: { description: "Lookup", inputSchema: { type: "object" } } };
    const toolChoice = { type: "tool", toolName: "lookup" };
    const responseSchema = { type: "object", properties: { answer: { type: "string" } } };

    const result = (await handleTextSmall(createRuntime(), {
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
    } as never)) as unknown as Record<string, unknown>;

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.messages).toBe(messages);
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
      schema: responseSchema,
    });
    expect(result).toMatchObject({
      text: "ok",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10, cachedPromptTokens: 5 },
    });
  }, 60_000);
});
