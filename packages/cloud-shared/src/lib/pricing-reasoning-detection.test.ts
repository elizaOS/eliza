/**
 * Tests for modelUsesReasoningTokens — the detector that drives the
 * reasoning-model output-token budget floor in the chat-completions route.
 *
 * Background: reasoning models spend output tokens on hidden chain-of-thought
 * before emitting a visible answer. If max_tokens does not leave room past the
 * reasoning, they truncate mid-thought and return empty (but billed) content.
 * The route uses this detector to guarantee a minimum response budget. A false
 * positive only nudges the token floor up; a false negative bills callers for
 * empty output, so the matcher is intentionally broad.
 */

import { describe, expect, test } from "bun:test";

import { isReasoningModel, modelUsesReasoningTokens } from "./pricing";

describe("modelUsesReasoningTokens", () => {
  test.each([
    "openai/o1",
    "openai/o1-mini",
    "openai/o3",
    "openai/o3-mini",
    "openai/o4-mini",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-sonnet-4.5",
    "deepseek/deepseek-r1",
    "deepseek/deepseek-reasoner",
    "minimax/minimax-m3",
    "minimax/minimax-m1",
    "qwen/qwq-32b",
    "qwen/qwen3.7-max",
    "allenai/olmo-3-32b-think",
    "nvidia/nemotron-3-super-120b-a12b-reasoning",
    "z-ai/glm-4.6-thinking",
    "moonshotai/kimi-k2.6-think",
    "x-ai/grok-4-reasoning",
  ])("treats %s as a reasoning model", (model) => {
    expect(modelUsesReasoningTokens(model)).toBe(true);
  });

  test.each([
    "openai/gpt-4o-mini",
    "openai/gpt-4.1-mini",
    "anthropic/claude-3.5-haiku",
    "google/gemini-2.5-flash",
    "meta-llama/llama-3.3-70b-instruct",
    "mistralai/mistral-small-latest",
    "deepseek/deepseek-chat",
    "minimax/minimax-text-01",
  ])("treats %s as a non-reasoning model", (model) => {
    expect(modelUsesReasoningTokens(model)).toBe(false);
  });

  test("matches a bare (provider-less) model name", () => {
    expect(modelUsesReasoningTokens("minimax-m3")).toBe(true);
    expect(modelUsesReasoningTokens("gpt-4o-mini")).toBe(false);
  });

  describe("catalog supported_parameters signal (authoritative)", () => {
    // These models do NOT carry a "think"/"reasoning" id, so name patterns miss
    // them, but the catalog advertises a reasoning parameter. They were the
    // exact models reported broken in production (kimi-k2.6, glm-5.1,
    // deepseek-v4-pro): at low max_tokens they spent the whole budget on hidden
    // reasoning and returned null content while billing the tokens.
    test.each([
      "moonshotai/kimi-k2.6",
      "z-ai/glm-5.1",
      "deepseek/deepseek-v4-pro",
    ])("%s is NOT caught by name pattern alone", (model) => {
      expect(modelUsesReasoningTokens(model)).toBe(false);
    });

    test.each([
      "moonshotai/kimi-k2.6",
      "z-ai/glm-5.1",
      "deepseek/deepseek-v4-pro",
    ])("%s IS caught when the catalog advertises reasoning", (model) => {
      expect(
        modelUsesReasoningTokens(model, [
          "max_tokens",
          "temperature",
          "reasoning",
          "include_reasoning",
        ]),
      ).toBe(true);
    });

    test("reasoning_effort alone is enough", () => {
      expect(modelUsesReasoningTokens("some/model", ["max_tokens", "reasoning_effort"])).toBe(true);
    });

    test("a non-reasoning catalog model stays false", () => {
      expect(
        modelUsesReasoningTokens("openai/gpt-4o-mini", [
          "max_tokens",
          "temperature",
          "tools",
          "response_format",
        ]),
      ).toBe(false);
    });

    test("empty/undefined supported_parameters falls back to name pattern", () => {
      expect(modelUsesReasoningTokens("minimax/minimax-m3", [])).toBe(true);
      expect(modelUsesReasoningTokens("openai/gpt-4o-mini", undefined)).toBe(false);
    });
  });

  test("is case-insensitive", () => {
    expect(modelUsesReasoningTokens("DeepSeek/DeepSeek-R1")).toBe(true);
  });

  test("the narrow isReasoningModel (temperature gate) stays narrow", () => {
    // isReasoningModel governs temperature stripping only; it must NOT expand
    // to the broad reasoning set or it would strip temperature from models that
    // accept it.
    expect(isReasoningModel("anthropic/claude-opus-4.8")).toBe(true);
    expect(isReasoningModel("openai/o3-mini")).toBe(true);
    expect(isReasoningModel("minimax/minimax-m3")).toBe(false);
    expect(isReasoningModel("deepseek/deepseek-r1")).toBe(false);
  });
});
