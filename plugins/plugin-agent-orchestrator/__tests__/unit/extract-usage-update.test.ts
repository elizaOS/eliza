import { describe, expect, it } from "vitest";
import { extractUsageUpdate } from "../../src/services/acp-service.js";

// Direct unit tests for the provider-usage boundary normalizer. It runs inside
// handleAcpEvent against raw ACP terminal-result payloads, whose token fields
// vary by provider (Anthropic Messages, OpenAI Chat/Responses, the
// claude-agent-sdk result). Exercising it through a live AcpService would
// require a spawned subprocess and a real prompt turn; the field-merging logic
// is what actually carries the risk, so it is tested in isolation.

describe("extractUsageUpdate", () => {
  it("normalizes an Anthropic Messages usage block and sums cache tokens", () => {
    const usage = extractUsageUpdate({
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 200,
    });
    expect(usage).toEqual({
      provider: "unknown",
      model: undefined,
      inputTokens: 1200,
      outputTokens: 340,
      reasoningTokens: 0,
      cacheTokens: 1000,
      costUsd: undefined,
      state: "measured",
    });
  });

  it("normalizes an OpenAI Chat usage block with nested reasoning + cached tokens", () => {
    const usage = extractUsageUpdate({
      prompt_tokens: 900,
      completion_tokens: 450,
      completion_tokens_details: { reasoning_tokens: 128 },
      prompt_tokens_details: { cached_tokens: 256 },
    });
    expect(usage?.inputTokens).toBe(900);
    expect(usage?.outputTokens).toBe(450);
    expect(usage?.reasoningTokens).toBe(128);
    expect(usage?.cacheTokens).toBe(256);
  });

  it("normalizes an OpenAI Responses usage block", () => {
    const usage = extractUsageUpdate({
      input_tokens: 600,
      output_tokens: 220,
      output_tokens_details: { reasoning_tokens: 64 },
      input_tokens_details: { cached_tokens: 100 },
    });
    expect(usage?.reasoningTokens).toBe(64);
    expect(usage?.cacheTokens).toBe(100);
  });

  it("reads the claude-agent-sdk result shape (usage nested + top-level cost)", () => {
    const result = { total_cost_usd: 0.0123, model: "claude-opus-4-7" };
    const nestedUsage = {
      input_tokens: 500,
      output_tokens: 90,
      cache_read_input_tokens: 50,
    };
    const usage = extractUsageUpdate(result, nestedUsage);
    expect(usage?.costUsd).toBeCloseTo(0.0123);
    expect(usage?.model).toBe("claude-opus-4-7");
    expect(usage?.inputTokens).toBe(500);
    expect(usage?.cacheTokens).toBe(50);
  });

  it("prefers an explicit camelCase cacheTokens over the Anthropic split fields", () => {
    const usage = extractUsageUpdate({
      inputTokens: 10,
      outputTokens: 5,
      cacheTokens: 999,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 2,
    });
    expect(usage?.cacheTokens).toBe(999);
  });

  it("carries provider and model through when present", () => {
    const usage = extractUsageUpdate({
      provider: "openai",
      model: "gpt-5.5",
      prompt_tokens: 1,
      completion_tokens: 1,
    });
    expect(usage?.provider).toBe("openai");
    expect(usage?.model).toBe("gpt-5.5");
  });

  it("returns undefined when no real token data is present (stays unavailable)", () => {
    expect(extractUsageUpdate(undefined)).toBeUndefined();
    expect(extractUsageUpdate({})).toBeUndefined();
    expect(
      extractUsageUpdate({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toBeUndefined();
    expect(extractUsageUpdate({ stopReason: "end_turn" })).toBeUndefined();
  });

  it("treats cost-only turns as real usage", () => {
    const usage = extractUsageUpdate({ total_cost_usd: 0.5 });
    expect(usage?.costUsd).toBe(0.5);
    expect(usage?.inputTokens).toBe(0);
  });
});
