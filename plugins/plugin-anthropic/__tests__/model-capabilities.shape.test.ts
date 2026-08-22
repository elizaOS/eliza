/**
 * Shape tests for temperature locks and max-output-token boundary resolution:
 * asserts `ANTHROPIC_TEMPERATURE_LOCKED_MODELS`, per-model / bare-number
 * `ANTHROPIC_MAX_OUTPUT_TOKENS`, and the built-in opus-4 substring rule against
 * a mocked runtime, capturing the params passed to the AI SDK. No live API.
 */
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

async function expectGenerateRejectedBeforeDispatch(
  settings: Record<string, string>,
  params: Record<string, unknown>,
  expected: Record<string, unknown>
): Promise<void> {
  const generateText = vi.fn();
  vi.doMock("ai", () => ({ generateText, streamText: vi.fn() }));
  vi.doMock("../providers/anthropic", () => ({
    createAnthropicClientWithTopPSupport: () => (modelName: string) => ({ modelId: modelName }),
  }));

  const { handleTextSmall } = await import("../models/text");
  await expect(
    handleTextSmall(createRuntime({ ANTHROPIC_API_KEY: "test-key", ...settings }), {
      prompt: "hello",
      ...params,
    } as never)
  ).rejects.toMatchObject(expected);
  expect(generateText).not.toHaveBeenCalled();
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

  it("rejects a request above a per-model ANTHROPIC_MAX_OUTPUT_TOKENS boundary", async () => {
    await expectGenerateRejectedBeforeDispatch(
      {
        ANTHROPIC_SMALL_MODEL: "claude-unknown-test-9",
        ANTHROPIC_MAX_OUTPUT_TOKENS: "claude-unknown-test-9:32000, some-other-model:8000",
      },
      { maxTokens: 100_000 },
      {
        code: "ANTHROPIC_OUTPUT_BUDGET_UNSUPPORTED",
        context: {
          modelName: "claude-unknown-test-9",
          requestedMaxTokens: 100_000,
          supportedMaxTokens: 32_000,
        },
      }
    );
  }, 60_000);

  it("rejects a request above a bare-number ANTHROPIC_MAX_OUTPUT_TOKENS boundary", async () => {
    await expectGenerateRejectedBeforeDispatch(
      {
        ANTHROPIC_SMALL_MODEL: "claude-unknown-test-9",
        ANTHROPIC_MAX_OUTPUT_TOKENS: "16000, some-other-model:8000",
      },
      { maxTokens: 100_000 },
      {
        code: "ANTHROPIC_OUTPUT_BUDGET_UNSUPPORTED",
        context: { requestedMaxTokens: 100_000, supportedMaxTokens: 16_000 },
      }
    );
  }, 60_000);

  it("keeps the opus-4 substring treatment for claude-opus-4-8 without any env config", async () => {
    const call = await captureGenerateParams(
      { ANTHROPIC_SMALL_MODEL: "claude-opus-4-8" },
      { temperature: 0.3, maxTokens: 32_000 }
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

  it("uses the full resolved model limit when maxTokens is omitted", async () => {
    const haiku = await captureGenerateParams(
      { ANTHROPIC_SMALL_MODEL: "claude-haiku-4-5" },
      { temperature: 0.3 }
    );
    expect(haiku.temperature).toBe(0.3);
    expect(haiku.maxOutputTokens).toBe(64_000);

    vi.resetModules();
    const unknown = await captureGenerateParams(
      { ANTHROPIC_SMALL_MODEL: "claude-unknown-test-9" },
      { temperature: 0.3 }
    );
    expect(unknown.temperature).toBe(0.3);
    expect(unknown.maxOutputTokens).toBe(64_000);
  }, 60_000);

  it("preserves an accepted explicit maxTokens value exactly", async () => {
    const call = await captureGenerateParams(
      { ANTHROPIC_SMALL_MODEL: "claude-unknown-test-9" },
      { maxTokens: 12_345 }
    );
    expect(call.maxOutputTokens).toBe(12_345);
  }, 60_000);

  it("rejects invalid explicit maxTokens values before dispatch", async () => {
    for (const requestedMaxTokens of [0, -1, 1.5, Number.NaN]) {
      await expectGenerateRejectedBeforeDispatch(
        { ANTHROPIC_SMALL_MODEL: "claude-unknown-test-9" },
        { maxTokens: requestedMaxTokens },
        { code: "ANTHROPIC_OUTPUT_BUDGET_INVALID" }
      );
      vi.resetModules();
    }
  }, 60_000);
});
