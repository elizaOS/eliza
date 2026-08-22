/**
 * Thinking-budget and max-output-token setting parsing.
 *
 * These values are sent to the Anthropic API on every request, so a silently
 * truncated setting bills a budget the operator never configured. plugin-zai
 * already parses the same setting strictly; this pins plugin-anthropic to the
 * same contract.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { getCoTBudget, getMaxOutputTokensOverride } from "../utils/config";

function runtimeWith(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
    character: { settings: {} },
  } as unknown as IAgentRuntime;
}

describe("getCoTBudget setting parsing", () => {
  it("rejects a trailing-garbage budget instead of billing its prefix", () => {
    // parseInt("2048junk") is 2048 — a thinking budget nobody configured,
    // charged on every request.
    const runtime = runtimeWith({ ANTHROPIC_COT_BUDGET_LARGE: "2048junk" });
    expect(() => getCoTBudget(runtime, "large")).toThrow(
      expect.objectContaining({
        code: "ANTHROPIC_COT_BUDGET_INVALID",
        context: expect.objectContaining({
          setting: "ANTHROPIC_COT_BUDGET_LARGE",
          value: "2048junk",
        }),
      })
    );
  });

  it("rejects a fractional budget", () => {
    const runtime = runtimeWith({ ANTHROPIC_COT_BUDGET_LARGE: "2048.9" });
    expect(() => getCoTBudget(runtime, "large")).toThrow(ElizaError);
  });

  it("rejects a budget beyond the safe integer range", () => {
    // parseInt returns 9007199254740992 for this — a value that is not what
    // was written, sent to a paid API.
    const runtime = runtimeWith({
      ANTHROPIC_COT_BUDGET_LARGE: "9007199254740993",
    });
    expect(() => getCoTBudget(runtime, "large")).toThrow(ElizaError);
  });

  it("still honours a clean budget from the specific and shared keys", () => {
    expect(getCoTBudget(runtimeWith({ ANTHROPIC_COT_BUDGET_LARGE: "0" }), "large")).toBe(0);
    expect(getCoTBudget(runtimeWith({ ANTHROPIC_COT_BUDGET_LARGE: "2048" }), "large")).toBe(2048);
    expect(getCoTBudget(runtimeWith({ ANTHROPIC_COT_BUDGET: "4096" }), "large")).toBe(4096);
  });

  it("surfaces a malformed specific key instead of hiding it behind the shared key", () => {
    const runtime = runtimeWith({
      ANTHROPIC_COT_BUDGET_SMALL: "junk",
      ANTHROPIC_COT_BUDGET: "1024",
    });
    expect(() => getCoTBudget(runtime, "small")).toThrow(
      expect.objectContaining({
        code: "ANTHROPIC_COT_BUDGET_INVALID",
        context: expect.objectContaining({
          setting: "ANTHROPIC_COT_BUDGET_SMALL",
          value: "junk",
        }),
      })
    );
  });
});

describe("getMaxOutputTokensOverride entry parsing", () => {
  it("rejects a prefix-parsed per-model cap", () => {
    const runtime = runtimeWith({
      ANTHROPIC_MAX_OUTPUT_TOKENS: "claude-sonnet-4:8192junk",
    });
    expect(() => getMaxOutputTokensOverride(runtime, "claude-sonnet-4")).toThrow(
      expect.objectContaining({
        code: "ANTHROPIC_MAX_OUTPUT_TOKENS_INVALID",
        context: expect.objectContaining({
          setting: "ANTHROPIC_MAX_OUTPUT_TOKENS",
          value: "8192junk",
          entry: "claude-sonnet-4:8192junk",
        }),
      })
    );
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
