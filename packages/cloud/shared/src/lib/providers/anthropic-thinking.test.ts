/** Verifies owner and deploy policy resolution for Anthropic thinking budgets at the shared cloud boundary. */
import { describe, expect, test } from "bun:test";
import {
  parseThinkingBudgetFromCharacterSettings,
  resolveAnthropicThinkingBudgetTokens,
} from "./anthropic-thinking";

describe("Anthropic thinking budget resolution", () => {
  test("uses the character override before the deploy default", () => {
    const characterBudget = parseThinkingBudgetFromCharacterSettings({
      anthropicThinkingBudgetTokens: 1_200,
    });

    expect(
      resolveAnthropicThinkingBudgetTokens(
        "anthropic/claude-opus-4-5",
        { ANTHROPIC_COT_BUDGET: "1800" },
        characterBudget,
      ),
    ).toBe(1_200);
  });

  test("uses the uncapped deploy default when the character omits a budget", () => {
    expect(
      resolveAnthropicThinkingBudgetTokens("anthropic/claude-opus-4-5", {
        ANTHROPIC_COT_BUDGET: "1600",
      }),
    ).toBe(1_600);
  });

  test("clamps both character and environment budgets to the operator cap", () => {
    expect(
      resolveAnthropicThinkingBudgetTokens("anthropic/claude-opus-4-5", {
        ANTHROPIC_COT_BUDGET: "3000",
        ANTHROPIC_COT_BUDGET_MAX: "2048",
      }),
    ).toBe(2_048);
    expect(
      resolveAnthropicThinkingBudgetTokens(
        "anthropic/claude-opus-4-5",
        { ANTHROPIC_COT_BUDGET_MAX: "2048" },
        4_096,
      ),
    ).toBe(2_048);
  });

  test("lets an explicit zero disable the deploy default", () => {
    expect(
      resolveAnthropicThinkingBudgetTokens(
        "anthropic/claude-opus-4-5",
        { ANTHROPIC_COT_BUDGET: "1600" },
        0,
      ),
    ).toBeNull();
  });

  test("disables thinking for unsupported providers and model families", () => {
    expect(
      resolveAnthropicThinkingBudgetTokens("openai/gpt-5", { ANTHROPIC_COT_BUDGET: "900" }),
    ).toBeNull();
    expect(
      resolveAnthropicThinkingBudgetTokens("anthropic/claude-3-opus", {
        ANTHROPIC_COT_BUDGET: "900",
      }),
    ).toBeNull();
  });
});
