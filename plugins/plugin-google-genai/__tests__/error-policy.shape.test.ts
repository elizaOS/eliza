/**
 * Failure-path tests for the #12182 error-handling policy (#12795) on the text
 * handlers: uninitialized client, provider rejection (401/429/500 passthrough),
 * and the empty-completion guard — a response with no text and no tool calls
 * (safety block / empty candidates) must surface as a typed
 * MODEL_EMPTY_COMPLETION error, never as a healthy "" completion. The core
 * runtime, config, events, and `generateContent` layers are mocked; no live
 * model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  createGoogleGenAI: vi.fn(),
  emitModelUsageEvent: vi.fn(),
  recordLlmCall: vi.fn(),
}));

vi.mock("@elizaos/core", () => ({
  ElizaError: class ElizaError extends Error {
    code?: string;
    context?: Record<string, unknown>;
    constructor(
      message: string,
      options?: {
        code?: string;
        cause?: unknown;
        context?: Record<string, unknown>;
      },
    ) {
      super(message, { cause: options?.cause });
      this.code = options?.code;
      this.context = options?.context;
    }
  },
  buildCanonicalSystemPrompt: vi.fn(
    ({ character }) => `canonical:${character?.name ?? "unknown"}`,
  ),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
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
  renderChatMessagesForPrompt: vi.fn(() => undefined),
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
  getSafetySettings: vi.fn(() => []),
  getSmallModel: vi.fn(() => "gemini-small"),
}));

vi.mock("../utils/events", () => ({
  emitModelUsageEvent: mocks.emitModelUsageEvent,
}));

vi.mock("../utils/tokenization", () => ({
  countTokens: vi.fn(async (text: string) => text.length),
}));

import { handleTextLarge, handleTextSmall } from "../models/text";

function runtime() {
  return {
    agentId: "agent-1",
    character: { name: "Gemini Tester" },
    getSetting: vi.fn(),
  };
}

describe("Google GenAI text failure surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createGoogleGenAI.mockReturnValue({
      models: { generateContent: mocks.generateContent },
    });
    mocks.recordLlmCall.mockImplementation(async (_runtime, _details, fn) =>
      fn(),
    );
  });

  it("throws a typed error when the client is uninitialized (missing credential)", async () => {
    mocks.createGoogleGenAI.mockReturnValue(null);

    await expect(
      handleTextSmall(runtime() as never, { prompt: "hello" } as never),
    ).rejects.toThrow("Google Generative AI client not initialized");
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  it.each([
    [401, "API key not valid"],
    [429, "Resource has been exhausted (e.g. check quota)"],
    [500, "Internal error encountered"],
  ])("rethrows a %s provider rejection unchanged", async (status, message) => {
    const providerError = Object.assign(new Error(message), { status });
    mocks.generateContent.mockRejectedValueOnce(providerError);

    await expect(
      handleTextSmall(runtime() as never, { prompt: "hello" } as never),
    ).rejects.toBe(providerError);
    expect(mocks.emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("throws MODEL_EMPTY_COMPLETION for a safety-blocked empty completion instead of returning ''", async () => {
    mocks.generateContent.mockResolvedValueOnce({
      candidates: [{ finishReason: "SAFETY", content: { parts: [] } }],
    });

    const rejection = handleTextSmall(
      runtime() as never,
      { prompt: "hello" } as never,
    );
    await expect(rejection).rejects.toThrow(
      /TEXT_SMALL returned an empty completion \(finishReason: SAFETY\)/,
    );
    await rejection.catch((error: Error & { code?: string }) => {
      expect(error.code).toBe("MODEL_EMPTY_COMPLETION");
    });
    // A failed call must not emit success usage telemetry.
    expect(mocks.emitModelUsageEvent).not.toHaveBeenCalled();
  });

  it("throws MODEL_EMPTY_COMPLETION when the provider returns no candidates at all", async () => {
    mocks.generateContent.mockResolvedValueOnce({});

    await expect(
      handleTextLarge(runtime() as never, { prompt: "hello" } as never),
    ).rejects.toThrow(/TEXT_LARGE returned an empty completion/);
  });

  it("does not throw for a tool-call-only completion with empty text", async () => {
    mocks.generateContent.mockResolvedValueOnce({
      text: "",
      functionCalls: [{ id: "call-1", name: "lookup", args: { q: "x" } }],
    });

    const result = (await handleTextSmall(
      runtime() as never,
      {
        prompt: "use the tool",
        tools: {
          lookup: {
            description: "Look things up",
            inputSchema: {
              type: "object",
              properties: { q: { type: "string" } },
            },
          },
        },
      } as never,
    )) as unknown as { text: string; toolCalls: unknown[] };

    expect(result.text).toBe("");
    expect(result.toolCalls).toHaveLength(1);
    expect(mocks.emitModelUsageEvent).toHaveBeenCalledTimes(1);
  });
});
