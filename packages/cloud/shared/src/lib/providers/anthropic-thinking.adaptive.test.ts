/**
 * Opus 4.7/4.8 use ADAPTIVE extended thinking; the shared helper must emit
 * `thinking: { type: "adaptive" }` (no `budgetTokens`) for them instead of the
 * manual `enabled + budgetTokens` that the provider 400s on, while manual-budget
 * models keep their existing shape (#16149).
 */
import { describe, expect, test } from "bun:test";
import {
  anthropicThinkingProviderOptions,
  supportsExtendedThinking,
  usesAdaptiveThinking,
} from "./anthropic-thinking";

const ENV = { ANTHROPIC_COT_BUDGET: "5000" };

function thinkingOf(modelId: string): Record<string, unknown> | undefined {
  const result = anthropicThinkingProviderOptions(modelId, ENV);
  if (!("providerOptions" in result)) return undefined;
  const anthropic = result.providerOptions.anthropic as
    | { thinking?: Record<string, unknown> }
    | undefined;
  return anthropic?.thinking;
}

function openRouterReasoningOf(modelId: string): Record<string, unknown> | undefined {
  const result = anthropicThinkingProviderOptions(modelId, ENV);
  if (!("providerOptions" in result)) return undefined;
  return result.providerOptions.openai;
}

describe("Anthropic adaptive thinking (Opus 4.7/4.8) — #16149", () => {
  // Bare, dot, hyphen, and provider-prefixed alias forms. (Model IDs are
  // lowercase by convention — `getProviderFromModel` is case-sensitive upstream,
  // so casing is out of scope for the adaptive-vs-manual routing this fixes.)
  const adaptiveAliases = [
    "claude-opus-4-7",
    "claude-opus-4.7",
    "anthropic/claude-opus-4-7",
    "anthropic/claude-opus-4-7-20260701",
    "anthropic/claude-opus-4.8",
    "claude-opus-4-8",
  ];

  for (const id of adaptiveAliases) {
    test(`${id} → adaptive thinking, never a manual budget`, () => {
      expect(usesAdaptiveThinking(id)).toBe(true);
      const thinking = thinkingOf(id);
      expect(thinking).toEqual({ type: "adaptive" });
      // Adaptive models reject a manual budget — assert neither casing leaks in.
      expect(JSON.stringify(thinking)).not.toContain("budgetTokens");
      expect(JSON.stringify(thinking)).not.toContain("budget_tokens");
      expect(openRouterReasoningOf(id)).toEqual({ reasoningEffort: "high" });
    });
  }

  test("manual-budget models keep enabled + budgetTokens", () => {
    for (const id of [
      "claude-opus-4-5",
      "claude-opus-4.6",
      "claude-sonnet-4-6",
      "anthropic/claude-sonnet-4",
    ]) {
      expect(usesAdaptiveThinking(id)).toBe(false);
      expect(supportsExtendedThinking(id)).toBe(true);
      expect(thinkingOf(id)).toEqual({ type: "enabled", budgetTokens: 5000 });
      expect(openRouterReasoningOf(id)).toBeUndefined();
    }
  });

  test("does not classify later, malformed, or lookalike model IDs as Opus 4.7/4.8", () => {
    for (const id of [
      "claude-opus-4-70",
      "claude-opus-4.80",
      "claude-opus-4-8preview",
      "not-claude-opus-4-7",
      "openai/not-claude-opus-4-8",
    ]) {
      expect(usesAdaptiveThinking(id)).toBe(false);
    }
  });

  test("unsupported models emit no thinking options", () => {
    for (const id of ["claude-3-5-haiku", "claude-instant-1", "claude-2"]) {
      expect(supportsExtendedThinking(id)).toBe(false);
      expect(anthropicThinkingProviderOptions(id, ENV)).toEqual({});
    }
  });

  test("a zero or absent budget disables thinking even for an adaptive model", () => {
    // Explicit 0 budget → off (the gate is unchanged for adaptive models).
    expect(anthropicThinkingProviderOptions("claude-opus-4-7", ENV, 0)).toEqual({});
    // No env budget configured → off.
    expect(anthropicThinkingProviderOptions("claude-opus-4-7", {})).toEqual({});
  });
});
