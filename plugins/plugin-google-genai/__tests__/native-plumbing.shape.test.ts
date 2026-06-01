import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  createGoogleGenAI: vi.fn(),
  emitModelUsageEvent: vi.fn(),
  recordLlmCall: vi.fn(),
}));

vi.mock("@elizaos/core", () => ({
  buildCanonicalSystemPrompt: vi.fn(({ character }) =>
    `canonical:${character?.name ?? "unknown"}`,
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
        .map((message) => `${message.role ?? "user"}:${message.content ?? message.text ?? ""}`)
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

  it("maps generic tools, toolChoice, response schema, and attachments into generateContent", async () => {
    const bytes = new Uint8Array([1, 2, 3]);

    await expect(
      handleTextSmall(runtime() as never, {
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
      } as never),
    ).resolves.toBe('{"ok":true}');

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

  it("omits duplicate system chat messages from the rendered prompt", async () => {
    await handleTextSmall(runtime() as never, {
      system: "Shared system",
      messages: [
        { role: "system", content: "Shared system" },
        { role: "user", content: "Hello" },
      ],
    } as never);

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
      handleTextSmall(runtime() as never, {
        prompt: "bad tool",
        tools: [{ description: "missing name" }],
      } as never),
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
