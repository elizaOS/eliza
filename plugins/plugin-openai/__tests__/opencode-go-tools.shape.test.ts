/**
 * Request-shape coverage for OpenCode Go DeepSeek V4 Flash. The provider's
 * no-thinking value is `reasoning_effort: none`, and forced native tool choice
 * must remain `required` on the same request. Mocked AI SDK, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: aiMocks.generateText,
  streamText: aiMocks.streamText,
  jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
  Output: {
    json: () => ({}),
    object: () => ({}),
  },
}));

vi.mock("../providers", () => ({
  createOpenAIClient: () => ({
    chat: (modelName: string) => ({ modelName }),
    responses: (modelName: string) => ({ modelName }),
  }),
}));

const ENV_KEYS = [
  "CEREBRAS_API_KEY",
  "ELIZA_MOCK_OPENAI_BASE",
  "ELIZA_PROVIDER",
  "EVOLINK_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_BROWSER_BASE_URL",
  "OPENAI_REASONING_EFFORT",
  "OPENAI_SMALL_MODEL",
  "SMALL_MODEL",
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
  aiMocks.generateText.mockResolvedValue({
    text: "",
    toolCalls: [{ toolName: "lookup", input: { q: "eliza" } }],
    finishReason: "tool-calls",
    usage: { inputTokens: 1, outputTokens: 1 },
    providerMetadata: {},
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function createRuntime(settings: Record<string, string | undefined>) {
  return {
    character: { name: "Ada", system: "system prompt" },
    emitEvent: vi.fn(),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    getSetting: vi.fn((key: string) => settings[key]),
  } as never;
}

async function captureRequest(
  settings: Record<string, string | undefined>,
  model = "deepseek-v4-flash"
): Promise<Record<string, unknown>> {
  const { handleTextSmall } = await import("../models/text");
  await handleTextSmall(createRuntime(settings), {
    prompt: "Use the lookup tool",
    model,
    tools: {
      lookup: {
        description: "Look something up",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
      },
    },
    toolChoice: "required",
    providerOptions: { eliza: { thinking: "off" } },
  } as never);

  return aiMocks.generateText.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe("OpenCode Go DeepSeek V4 Flash forced tools", () => {
  it("maps thinking=off to none while preserving required tool choice", async () => {
    const call = await captureRequest({
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: "https://opencode.ai/zen/go/v1",
    });

    expect(call.providerOptions).toMatchObject({
      openai: { reasoningEffort: "none" },
    });
    expect(call.toolChoice).toBe("required");
    expect(call.tools).toHaveProperty("lookup");
    expect(aiMocks.generateText).toHaveBeenCalledTimes(1);
  });

  it.each([
    "deepseek-v4-pro",
    "openai/deepseek-v4-flash",
    "deepseek-v4-flash:preview",
    "deepseek-v4-flash-free",
  ])("does not add reasoning effort for non-exact model %s", async (model) => {
    const call = await captureRequest(
      {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://opencode.ai/zen/go/v1",
      },
      model
    );

    expect(call.providerOptions).not.toHaveProperty("openai.reasoningEffort");
    expect(call.toolChoice).toBe("required");
  });

  it("does not add reasoning effort for the same model on another endpoint", async () => {
    const call = await captureRequest({
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
    });

    expect(call.providerOptions).not.toHaveProperty("openai.reasoningEffort");
    expect(call.toolChoice).toBe("required");
  });

  it("does not inherit OpenCode semantics through an opaque browser proxy", async () => {
    vi.stubGlobal("document", {});
    const call = await captureRequest({
      OPENAI_BASE_URL: "https://opencode.ai/zen/go/v1/",
      OPENAI_BROWSER_BASE_URL: "https://app.example.test/openai-proxy",
    });

    expect(call.providerOptions).not.toHaveProperty("openai.reasoningEffort");
    expect(call.toolChoice).toBe("required");
  });

  it("recognizes an exact OpenCode browser base without changing the node base", async () => {
    vi.stubGlobal("document", {});
    const call = await captureRequest({
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      OPENAI_BROWSER_BASE_URL: "https://opencode.ai/zen/go/v1/",
    });

    expect(call.providerOptions).toMatchObject({
      openai: { reasoningEffort: "none" },
    });
    expect(call.toolChoice).toBe("required");
  });
});
