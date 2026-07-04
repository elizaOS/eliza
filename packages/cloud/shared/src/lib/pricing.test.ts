// Exercises pricing behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  estimateTokens,
  getProviderFromModel,
  getSafeModelParams,
  isReasoningModel,
  modelUsesReasoningTokens,
  normalizeModelName,
} from "./pricing";

/**
 * Model routing + parameter-safety helpers. getSafeModelParams must strip
 * options the provider rejects (Anthropic: frequency/presence penalties; all
 * reasoning models: temperature) — sending a rejected param fails the upstream
 * call. modelUsesReasoningTokens drives the response-token floor: a false
 * negative silently bills the caller for empty (truncated) completions.
 */

describe("getProviderFromModel / normalizeModelName", () => {
  test("resolves provider from prefix, slash-form, and bare names", () => {
    expect(getProviderFromModel("openrouter:meta/llama")).toBe("openrouter");
    expect(getProviderFromModel("anthropic/claude-opus-4")).toBe("anthropic");
    expect(getProviderFromModel("gpt-5-mini")).toBe("openai");
    expect(getProviderFromModel("gemma-4-31b")).toBe("cerebras");
    expect(getProviderFromModel("claude-sonnet-4")).toBe("anthropic");
    expect(getProviderFromModel("gemini-2.0")).toBe("google");
  });

  test("normalizeModelName strips provider prefixes", () => {
    expect(normalizeModelName("openai/gpt-5-mini")).toBe("gpt-5-mini");
    expect(normalizeModelName("openrouter:zai-glm-4.7")).toBe("zai-glm-4.7");
    expect(normalizeModelName("gpt-5-mini")).toBe("gpt-5-mini");
  });
});

describe("reasoning detection", () => {
  test("isReasoningModel is narrow (temperature-stripping only)", () => {
    expect(isReasoningModel("claude-opus-4")).toBe(true);
    expect(isReasoningModel("o1")).toBe(true);
    expect(isReasoningModel("gpt-5-mini")).toBe(false);
  });

  test("modelUsesReasoningTokens trusts catalog params, then name patterns", () => {
    // catalog signal alone is enough, even for an unknown id.
    expect(modelUsesReasoningTokens("mystery-model", ["reasoning"])).toBe(true);
    // name-pattern fallback for Cerebras reasoning defaults.
    expect(modelUsesReasoningTokens("gemma-4-31b")).toBe(true);
    expect(modelUsesReasoningTokens("gpt-oss-120b")).toBe(true);
    expect(modelUsesReasoningTokens("deepseek-r1")).toBe(true);
    expect(modelUsesReasoningTokens("gpt-4o-mini")).toBe(false);
  });
});

describe("getSafeModelParams", () => {
  const base = {
    temperature: 0.7,
    topK: 40,
    frequencyPenalty: 0.5,
    presencePenalty: 0.5,
  };

  test("Anthropic strips frequency/presence penalties, keeps temperature for non-reasoning", () => {
    const out = getSafeModelParams("anthropic/claude-sonnet-4", base);
    expect(out.frequencyPenalty).toBeUndefined();
    expect(out.presencePenalty).toBeUndefined();
    expect(out.temperature).toBe(0.7);
  });

  test("reasoning model drops temperature", () => {
    const out = getSafeModelParams("claude-opus-4", base);
    expect(out.temperature).toBeUndefined();
  });

  test("non-Anthropic strips topK", () => {
    const out = getSafeModelParams("gpt-5-mini", base);
    expect(out.topK).toBeUndefined();
    expect(out.frequencyPenalty).toBe(0.5);
  });
});

describe("estimateTokens", () => {
  test("~4 chars per token, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
