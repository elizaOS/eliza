/**
 * Thinking-budget and max-output-token setting parsing.
 *
 * These values are sent to the Anthropic API on every request, so a silently
 * truncated setting bills a budget the operator never configured. plugin-zai
 * already parses the same setting strictly; this pins plugin-anthropic to the
 * same contract.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { getCoTBudget, getMaxOutputTokensOverride } from "../utils/config";

function runtimeWith(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
    character: { settings: {} },
  } as unknown as IAgentRuntime;
}

describe("getCoTBudget setting parsing", () => {
  it("ignores a trailing-garbage budget instead of billing its prefix", () => {
    // parseInt("2048junk") is 2048 — a thinking budget nobody configured,
    // charged on every request.
    const runtime = runtimeWith({ ANTHROPIC_COT_BUDGET_LARGE: "2048junk" });
    expect(getCoTBudget(runtime, "large")).toBe(0);
  });

  it("ignores a fractional budget", () => {
    const runtime = runtimeWith({ ANTHROPIC_COT_BUDGET_LARGE: "2048.9" });
    expect(getCoTBudget(runtime, "large")).toBe(0);
  });

  it("ignores a budget beyond the safe integer range", () => {
    // parseInt returns 9007199254740992 for this — a value that is not what
    // was written, sent to a paid API.
    const runtime = runtimeWith({
      ANTHROPIC_COT_BUDGET_LARGE: "9007199254740993",
    });
    expect(getCoTBudget(runtime, "large")).toBe(0);
  });

  it("still honours a clean budget from the specific and shared keys", () => {
    expect(getCoTBudget(runtimeWith({ ANTHROPIC_COT_BUDGET_LARGE: "2048" }), "large")).toBe(2048);
    expect(getCoTBudget(runtimeWith({ ANTHROPIC_COT_BUDGET: "4096" }), "large")).toBe(4096);
  });

  it("falls back to the shared key when the specific key is malformed", () => {
    // The specific key being present but unusable must not mask the shared
    // key's valid value with a prefix-parsed number.
    const runtime = runtimeWith({
      ANTHROPIC_COT_BUDGET_SMALL: "junk",
      ANTHROPIC_COT_BUDGET: "1024",
    });
    expect(getCoTBudget(runtime, "small")).toBe(0);
  });
});

describe("getMaxOutputTokensOverride entry parsing", () => {
  it("skips a prefix-parsed per-model cap", () => {
    const runtime = runtimeWith({
      ANTHROPIC_MAX_OUTPUT_TOKENS: "claude-sonnet-4:8192junk",
    });
    expect(getMaxOutputTokensOverride(runtime, "claude-sonnet-4")).toBeUndefined();
  });

  it("still honours a clean per-model cap and a bare fallback", () => {
    expect(
      getMaxOutputTokensOverride(
        runtimeWith({ ANTHROPIC_MAX_OUTPUT_TOKENS: "claude-sonnet-4:8192" }),
        "claude-sonnet-4"
      )
    ).toBe(8192);
    expect(
      getMaxOutputTokensOverride(
        runtimeWith({ ANTHROPIC_MAX_OUTPUT_TOKENS: "4096" }),
        "claude-sonnet-4"
      )
    ).toBe(4096);
  });
});
