/**
 * Unit tests for the generic-to-Google request/response plumbing in
 * `models/text`: tool + toolChoice + responseSchema + attachment mapping into
 * `generateContent`, native tool-call extraction, duplicate-system-message
 * elision, and the unnamed-tool / uninitialized-client error paths. The core
 * runtime and `generateContent` are mocked — no live model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  createGoogleGenAI: vi.fn(),
  emitModelUsageEvent: vi.fn(),
  recordLlmCall: vi.fn(),
}));

vi.mock("@elizaos/core", () => ({
  buildCanonicalSystemPrompt: vi.fn(
    ({ character }) => `canonical:${character?.name ?? "unknown"}`,
  ),
  logger: {
    error: vi.fn(),
    log: vi.fn(),
  },
  ModelType: {
    TEXT_NANO: "TEXT_NANO",
    TEXT_SMALL: "TEXT_SMALL",
    TEXT_MEDIUM: "TEXT_MEDIUM",
    TEXT_LARGE: "TEXT_LARGE",
    TEXT_MEGA: "TEXT_MEGA",
    RESPONSE_HANDLER: "RESPONSE_HANDLER",
    ACTION_PLANNER: "ACTION_PLANNER",
  },
  recordLlmCall: mocks.recordLlmCall,
  renderChatMessagesForPrompt: vi.fn(
    (
      messages:
        | Array<{ role?: string; content?: string; text?: string }>
        | undefined,
      options?: { omitDuplicateSystem?: string },
    ) => {
      if (!messages?.length) return undefined;
      return messages
        .filter(
          (message) =>
            !(
              message.role === "system" &&
              (message.content ?? message.text) === options?.omitDuplicateSystem
            ),
        )
        .map(
          (message) =>
            `${message.role ?? "user"}:${message.content ?? message.text ?? ""}`,
        )
        .join("\n");
    },
  ),
  resolveEffectiveSystemPrompt: vi.fn(({ params, fallback }) =>
    typeof params.system === "string" ? params.system : fallback,
  ),
}));

vi.mock("../utils/config", () => ({
  createGoogleGenAI: mocks.createGoogleGenAI,
  getActionPlannerModel: vi.fn(() => "gemini-action"),
  getLargeModel: vi.fn(() => "gemini-large"),
  getMediumModel: vi.fn(() => "gemini-medium"),
  getMegaModel: vi.fn(() => "gemini-mega"),
  getNanoModel: vi.fn(() => "gemini-nano"),
  getResponseHandlerModel: vi.fn(() => "gemini-response"),
  getSafetySettings: vi.fn(() => [{ category: "safe", threshold: "none" }]),
  getSmallModel: vi.fn(() => "gemini-small"),
}));

vi.mock("../utils/events", () => ({
  emitModelUsageEvent: mocks.emitModelUsageEvent,
}));

vi.mock("../utils/tokenization", () => ({
  countTokens: vi.fn(async (text: string) => text.length),
}));

import { handleTextSmall } from "../models/text";

function runtime() {
  return {
    agentId: "agent-1",
    character: { name: "Gemini Tester" },
    getSetting: vi.fn(),
  };
}

describe("Google GenAI text native plumbing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateContent.mockResolvedValue({ text: '{"ok":true}' });
    mocks.createGoogleGenAI.mockReturnValue({
      models: {
        generateContent: mocks.generateContent,
      },
    });
    mocks.recordLlmCall.mockImplementation(async (_runtime, _details, fn) =>
      fn(),
    );
  });

  it("keeps legacy prompt-only calls as plain text", async () => {
    await expect(
      handleTextSmall(runtime() as never, { prompt: "hello" } as never),
    ).resolves.toBe('{"ok":true}');
  });

  it("maps generic tools, toolChoice, response schema, and attachments into generateContent", async () => {
    const bytes = new Uint8Array([1, 2, 3]);

    const result = (await handleTextSmall(
      runtime() as never,
      {
        prompt: "Use the tools",
        system: "You are concise.",
        temperature: 0.2,
        maxTokens: 123,
        stopSequences: ["STOP"],
        tools: {
          lookup_weather: {
            description: "Get weather",
            inputSchema: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
              required: ["city"],
            },
          },
        },
        toolChoice: { type: "tool", toolName: "lookup_weather" },
        responseSchema: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
          },
        },
        attachments: [
          {
            data: "data:image/png;base64,AAA=",
            mediaType: "image/png",
          },
          {
            data: "https://files.example/doc.pdf",
            mediaType: "application/pdf",
          },
          {
            data: bytes,
            mediaType: "application/octet-stream",
          },
        ],
      } as never,
    )) as unknown as {
      text: string;
      toolCalls: unknown[];
      usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      };
      providerMetadata: { provider: string; modelName: string };
    };

    expect(result).toMatchObject({
      text: '{"ok":true}',
      toolCalls: [],
      usage: {
        promptTokens: "Use the tools".length,
        completionTokens: '{"ok":true}'.length,
        totalTokens: "Use the tools".length + '{"ok":true}'.length,
      },
      providerMetadata: {
        provider: "google-genai",
        modelName: "gemini-small",
      },
    });

    expect(mocks.generateContent).toHaveBeenCalledWith({
      model: "gemini-small",
      contents: [
        {
          role: "user",
          parts: [
            { text: "Use the tools" },
            { inlineData: { mimeType: "image/png", data: "AAA=" } },
            {
              fileData: {
                mimeType: "application/pdf",
                fileUri: "https://files.example/doc.pdf",
              },
            },
            {
              inlineData: {
                mimeType: "application/octet-stream",
                data: Buffer.from(bytes).toString("base64"),
              },
            },
          ],
        },
      ],
      config: expect.objectContaining({
        temperature: 0.2,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 123,
        stopSequences: ["STOP"],
        safetySettings: [{ category: "safe", threshold: "none" }],
        systemInstruction: "You are concise.",
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
          },
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: "lookup_weather",
                description: "Get weather",
                parameters: {
                  type: "object",
                  properties: {
                    city: { type: "string" },
                  },
                  required: ["city"],
                },
              },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: ["lookup_weather"],
          },
        },
      }),
    });
    expect(mocks.emitModelUsageEvent).toHaveBeenCalledWith(
      expect.anything(),
      "TEXT_SMALL",
      "Use the tools",
      {
        promptTokens: "Use the tools".length,
        completionTokens: '{"ok":true}'.length,
        totalTokens: "Use the tools".length + '{"ok":true}'.length,
      },
    );
  });

  it("surfaces a Gemini functionCalls response as native tool calls and records it", async () => {
    mocks.generateContent.mockResolvedValueOnce({
      text: "",
      functionCalls: [
        {
          id: "weather-call-1",
          name: "lookup_weather",
          args: { city: "Paris", unit: "celsius" },
        },
      ],
      candidates: [{ finishReason: "STOP" }],
      modelVersion: "gemini-2.0-flash-001",
      responseId: "response-1",
      usageMetadata: {
        promptTokenCount: 11,
        candidatesTokenCount: 3,
        totalTokenCount: 14,
      },
    });

    const result = (await handleTextSmall(
      runtime() as never,
      {
        prompt: "Check Paris weather",
        tools: {
          lookup_weather: {
            description: "Get weather",
            inputSchema: {
              type: "object",
              properties: {
                city: { type: "string" },
                unit: { type: "string" },
              },
            },
          },
        },
        toolChoice: { type: "tool", toolName: "lookup_weather" },
      } as never,
    )) as unknown as {
      text: string;
      toolCalls: unknown[];
      finishReason: string;
      usage: unknown;
      providerMetadata: unknown;
    };

    const expectedToolCalls = [
      {
        id: "weather-call-1",
        name: "lookup_weather",
        arguments: { city: "Paris", unit: "celsius" },
        toolName: "lookup_weather",
        toolCallId: "weather-call-1",
        type: "function",
        args: { city: "Paris", unit: "celsius" },
        input: { city: "Paris", unit: "celsius" },
      },
    ];

    expect(result).toMatchObject({
      text: "",
      toolCalls: expectedToolCalls,
      finishReason: "tool-calls",
      usage: {
        promptTokens: 11,
        completionTokens: 3,
        totalTokens: 14,
      },
      providerMetadata: {
        provider: "google-genai",
        modelName: "gemini-small",
        modelVersion: "gemini-2.0-flash-001",
        responseId: "response-1",
      },
    });

    const details = mocks.recordLlmCall.mock.calls.at(-1)?.[1];
    expect(details).toMatchObject({
      response: "",
      toolCalls: expectedToolCalls,
      finishReason: "tool-calls",
      promptTokens: 11,
      completionTokens: 3,
      providerMetadata: {
        provider: "google-genai",
        modelName: "gemini-small",
      },
    });
  });

  it("extracts multiple Gemini function calls from candidate content parts", async () => {
    mocks.generateContent.mockResolvedValueOnce({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: "I will check both." },
              {
                functionCall: {
                  name: "lookup_weather",
                  args: { city: "Paris" },
                },
              },
              {
                functionCall: {
                  id: "timezone-call-1",
                  name: "lookup_timezone",
                  args: { city: "Paris" },
                },
              },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 9,
        candidatesTokenCount: 5,
        totalTokenCount: 14,
      },
    });

    const result = (await handleTextSmall(
      runtime() as never,
      {
        prompt: "Check Paris weather and timezone",
        tools: [
          {
            name: "lookup_weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
          {
            name: "lookup_timezone",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        ],
      } as never,
    )) as unknown as {
      text: string;
      toolCalls: Array<{ id: string; name: string; input: unknown }>;
      finishReason: string;
    };

    expect(result.text).toBe("I will check both.");
    expect(result.finishReason).toBe("tool-calls");
    expect(result.toolCalls).toMatchObject([
      {
        id: "google-genai-tool-call-1",
        name: "lookup_weather",
        input: { city: "Paris" },
      },
      {
        id: "timezone-call-1",
        name: "lookup_timezone",
        input: { city: "Paris" },
      },
    ]);
  });

  it("omits duplicate system chat messages from the rendered prompt", async () => {
    const result = (await handleTextSmall(
      runtime() as never,
      {
        system: "Shared system",
        messages: [
          { role: "system", content: "Shared system" },
          { role: "user", content: "Hello" },
        ],
      } as never,
    )) as unknown as { text: string; toolCalls: unknown[] };

    expect(result).toMatchObject({
      text: '{"ok":true}',
      toolCalls: [],
    });

    expect(mocks.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: "user:Hello",
        config: expect.objectContaining({
          systemInstruction: "Shared system",
        }),
      }),
    );
  });

  it("rejects unnamed generic tool definitions before calling the SDK", async () => {
    await expect(
      handleTextSmall(
        runtime() as never,
        {
          prompt: "bad tool",
          tools: [{ description: "missing name" }],
        } as never,
      ),
    ).rejects.toThrow("[GoogleGenAI] Tool definition is missing a name.");
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  it("fails clearly when the Google client is not initialized", async () => {
    mocks.createGoogleGenAI.mockReturnValueOnce(null);

    await expect(
      handleTextSmall(runtime() as never, { prompt: "hello" } as never),
    ).rejects.toThrow("Google Generative AI client not initialized");
  });
});
