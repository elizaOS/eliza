/**
 * Shape tests for the effort/thinking provider options: ANTHROPIC_EFFORT(_SMALL/
 * _LARGE) becomes adaptive thinking + the AI SDK `effort` option, per-model
 * ceilings clamp xhigh/max on models that reject them, the legacy fixed CoT
 * budget survives (and loses to effort), invalid values are dropped, and
 * thinking-active requests carry temperature=1 with topP removed. Drives the
 * real handlers against a mocked AI SDK — no live API.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime(settings: Record<string, string>) {
  return {
    character: { name: "Claude Agent", system: "system prompt" },
    emitEvent: vi.fn(),
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

function mockAiSdk() {
  const generateText = vi.fn(async () => ({
    text: "ok",
    finishReason: "stop",
    usage: { inputTokens: 5, outputTokens: 2 },
  }));
  vi.doMock("ai", () => ({ generateText, streamText: vi.fn() }));
  vi.doMock("../providers/anthropic", () => ({
    createAnthropicClientWithTopPSupport: () => (modelName: string) => ({
      modelId: modelName,
    }),
  }));
  return generateText;
}

function anthropicOptionsOf(generateText: ReturnType<typeof vi.fn>) {
  const call = generateText.mock.calls[0]?.[0] as
    | {
        providerOptions?: { anthropic?: Record<string, unknown> };
        temperature?: number;
        topP?: number;
      }
    | undefined;
  if (!call) throw new Error("generateText was not called");
  return {
    anthropic: call.providerOptions?.anthropic,
    temperature: call.temperature,
    topP: call.topP,
  };
}

afterEach(() => {
  vi.doUnmock("ai");
  vi.doUnmock("../providers/anthropic");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("Anthropic effort/thinking provider options", () => {
  it("sends adaptive thinking + effort from ANTHROPIC_EFFORT_LARGE and forces temperature=1", async () => {
    const generateText = mockAiSdk();
    const { handleTextLarge } = await import("../models/text");
    await handleTextLarge(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_LARGE_MODEL: "claude-opus-4-8",
        ANTHROPIC_EFFORT_LARGE: "xhigh",
      }),
      { prompt: "hi", temperature: 0.7 } as never
    );
    const { anthropic, temperature } = anthropicOptionsOf(generateText);
    expect(anthropic?.thinking).toEqual({ type: "adaptive" });
    expect(anthropic?.effort).toBe("xhigh");
    expect(temperature).toBe(1);
  }, 60_000);

  it("falls back to the shared ANTHROPIC_EFFORT and normalizes case", async () => {
    const generateText = mockAiSdk();
    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_SMALL_MODEL: "claude-sonnet-5",
        ANTHROPIC_EFFORT: "Medium",
      }),
      { prompt: "hi" } as never
    );
    const { anthropic } = anthropicOptionsOf(generateText);
    expect(anthropic?.effort).toBe("medium");
    expect(anthropic?.thinking).toEqual({ type: "adaptive" });
  }, 60_000);

  it("clamps xhigh to high on models without the extended tiers (sonnet)", async () => {
    const generateText = mockAiSdk();
    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_SMALL_MODEL: "claude-sonnet-4-6",
        ANTHROPIC_EFFORT_SMALL: "xhigh",
      }),
      { prompt: "hi" } as never
    );
    const { anthropic } = anthropicOptionsOf(generateText);
    expect(anthropic?.effort).toBe("high");
  }, 60_000);

  // Live-probed 2026-07-12: haiku-4-5 rejects the effort parameter outright
  // ("This model does not support the effort parameter"), so a configured
  // effort must never reach the wire for it.
  it("never sends effort for haiku (model rejects the parameter)", async () => {
    const generateText = mockAiSdk();
    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_SMALL_MODEL: "claude-haiku-4-5-20251001",
        ANTHROPIC_EFFORT_SMALL: "high",
      }),
      { prompt: "hi" } as never
    );
    const { anthropic } = anthropicOptionsOf(generateText);
    expect(anthropic?.effort).toBeUndefined();
    expect(anthropic?.thinking).toBeUndefined();
  }, 60_000);

  it("falls back to the CoT budget on haiku when both are configured", async () => {
    const generateText = mockAiSdk();
    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_SMALL_MODEL: "claude-haiku-4-5-20251001",
        ANTHROPIC_EFFORT_SMALL: "high",
        ANTHROPIC_COT_BUDGET_SMALL: "1024",
      }),
      { prompt: "hi" } as never
    );
    const { anthropic } = anthropicOptionsOf(generateText);
    expect(anthropic?.effort).toBeUndefined();
    expect(anthropic?.thinking).toEqual({ type: "enabled", budgetTokens: 1024 });
  }, 60_000);

  it("keeps max on fable-5", async () => {
    const generateText = mockAiSdk();
    const { handleTextLarge } = await import("../models/text");
    await handleTextLarge(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_LARGE_MODEL: "claude-fable-5",
        ANTHROPIC_EFFORT_LARGE: "max",
      }),
      { prompt: "hi" } as never
    );
    const { anthropic } = anthropicOptionsOf(generateText);
    expect(anthropic?.effort).toBe("max");
  }, 60_000);

  it("ignores an invalid effort value and sends no thinking block", async () => {
    const generateText = mockAiSdk();
    const { handleTextLarge } = await import("../models/text");
    await handleTextLarge(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_LARGE_MODEL: "claude-sonnet-5",
        ANTHROPIC_EFFORT_LARGE: "turbo",
      }),
      { prompt: "hi" } as never
    );
    const { anthropic, temperature } = anthropicOptionsOf(generateText);
    expect(anthropic?.effort).toBeUndefined();
    expect(anthropic?.thinking).toBeUndefined();
    expect(temperature).toBe(0.7);
  }, 60_000);

  it("keeps the legacy fixed CoT budget shape when no effort is configured", async () => {
    const generateText = mockAiSdk();
    const { handleTextLarge } = await import("../models/text");
    await handleTextLarge(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_LARGE_MODEL: "claude-sonnet-5",
        ANTHROPIC_COT_BUDGET: "2048",
      }),
      { prompt: "hi", temperature: 0.5 } as never
    );
    const { anthropic, temperature } = anthropicOptionsOf(generateText);
    expect(anthropic?.thinking).toEqual({ type: "enabled", budgetTokens: 2048 });
    expect(anthropic?.effort).toBeUndefined();
    // Thinking-active requests only accept temperature=1.
    expect(temperature).toBe(1);
  }, 60_000);

  it("prefers effort over a configured CoT budget when both are set", async () => {
    const generateText = mockAiSdk();
    const { handleTextLarge } = await import("../models/text");
    await handleTextLarge(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_LARGE_MODEL: "claude-opus-4-8",
        ANTHROPIC_COT_BUDGET: "2048",
        ANTHROPIC_EFFORT_LARGE: "high",
      }),
      { prompt: "hi" } as never
    );
    const { anthropic } = anthropicOptionsOf(generateText);
    expect(anthropic?.thinking).toEqual({ type: "adaptive" });
    expect(anthropic?.effort).toBe("high");
  }, 60_000);

  it("drops topP when thinking is active", async () => {
    const generateText = mockAiSdk();
    const { handleTextLarge } = await import("../models/text");
    await handleTextLarge(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_LARGE_MODEL: "claude-sonnet-5",
        ANTHROPIC_EFFORT_LARGE: "low",
      }),
      { prompt: "hi", topP: 0.9 } as never
    );
    const { anthropic, topP } = anthropicOptionsOf(generateText);
    expect(anthropic?.effort).toBe("low");
    expect(topP).toBeUndefined();
  }, 60_000);
});
