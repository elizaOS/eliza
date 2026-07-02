import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime(settings: Record<string, string>) {
  return {
    character: { name: "Claude Agent", system: "system prompt" },
    emitEvent: vi.fn(),
    getSetting: vi.fn((key: string) => settings[key]),
  } as IAgentRuntime;
}

async function captureGenerateParams(
  settings: Record<string, string>,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const generateText = vi.fn(async () => ({
    text: "ok",
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  vi.doMock("ai", () => ({ generateText, streamText: vi.fn() }));
  vi.doMock("../providers/anthropic", () => ({
    createAnthropicClientWithTopPSupport: () => (modelName: string) => ({ modelId: modelName }),
  }));

  const { handleTextSmall } = await import("../models/text");
  await handleTextSmall(createRuntime({ ANTHROPIC_API_KEY: "test-key", ...settings }), {
    prompt: "hello",
    ...params,
  } as never);

  expect(generateText).toHaveBeenCalledTimes(1);
  return generateText.mock.calls[0][0] as Record<string, unknown>;
}

afterEach(() => {
  vi.doUnmock("ai");
  vi.doUnmock("../providers/anthropic");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("Anthropic model capability configuration", () => {
  it("locks temperature to 1 for an unknown model id listed in ANTHROPIC_TEMPERATURE_LOCKED_MODELS", async () => {
    const call = await captureGenerateParams(
      {
        ANTHROPIC_SMALL_MODEL: "claude-unknown-test-9",
        ANTHROPIC_TEMPERATURE_LOCKED_MODELS: " Claude-Unknown-Test-9 , some-other-model",
      },
      { temperature: 0.3 }
    );
    expect(call.temperature).toBe(1);
  }, 60_000);

  it("applies a per-model ANTHROPIC_MAX_OUTPUT_TOKENS cap to an unknown model id", async () => {
    const call = await captureGenerateParams(
      {
        ANTHROPIC_SMALL_MODEL: "claude-unknown-test-9",
        ANTHROPIC_MAX_OUTPUT_TOKENS: "claude-unknown-test-9:32000, some-other-model:8000",
      },
      { maxTokens: 100_000 }
    );
    expect(call.maxOutputTokens).toBe(32_000);
  }, 60_000);

  it("applies a bare-number ANTHROPIC_MAX_OUTPUT_TOKENS to models without a per-model entry", async () => {
    const call = await captureGenerateParams(
      {
        ANTHROPIC_SMALL_MODEL: "claude-unknown-test-9",
        ANTHROPIC_MAX_OUTPUT_TOKENS: "16000, some-other-model:8000",
      },
      { maxTokens: 100_000 }
    );
    expect(call.maxOutputTokens).toBe(16_000);
  }, 60_000);

  it("keeps the opus-4 substring treatment for claude-opus-4-8 without any env config", async () => {
    const call = await captureGenerateParams(
      { ANTHROPIC_SMALL_MODEL: "claude-opus-4-8" },
      { temperature: 0.3, maxTokens: 100_000 }
    );
    expect(call.temperature).toBe(1);
    expect(call.maxOutputTokens).toBe(32_000);
  }, 60_000);

  it("locks temperature for claude-sonnet-5 when the operator lists it", async () => {
    const call = await captureGenerateParams(
      {
        ANTHROPIC_SMALL_MODEL: "claude-sonnet-5",
        ANTHROPIC_TEMPERATURE_LOCKED_MODELS: "claude-sonnet-5",
      },
      { temperature: 0.3 }
    );
    expect(call.temperature).toBe(1);
  }, 60_000);

  it("keeps generic defaults for unlisted models (claude-haiku-4-5 and an unknown id)", async () => {
    const haiku = await captureGenerateParams(
      { ANTHROPIC_SMALL_MODEL: "claude-haiku-4-5" },
      { temperature: 0.3, maxTokens: 100_000 }
    );
    expect(haiku.temperature).toBe(0.3);
    expect(haiku.maxOutputTokens).toBe(64_000);

    vi.resetModules();
    const unknown = await captureGenerateParams(
      { ANTHROPIC_SMALL_MODEL: "claude-unknown-test-9" },
      { temperature: 0.3, maxTokens: 100_000 }
    );
    expect(unknown.temperature).toBe(0.3);
    expect(unknown.maxOutputTokens).toBe(64_000);
  }, 60_000);
});
