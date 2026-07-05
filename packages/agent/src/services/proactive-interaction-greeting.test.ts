/**
 * Unit tests for the per-view anticipatory-greeting plumbing (#13587): the judge
 * prompt reflects the declared intent + live state, and the confidence floor is
 * dropped only for intent-bearing views (suppression on no-intent views intact).
 * Pure functions only — no runtime, model, or DB.
 */
import type { ViewSwitchedPayload } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  buildProactiveJudgePrompt,
  parseProactiveJudgeDecisionOutput,
} from "./proactive-interaction-decider.ts";

function viewSwitch(
  overrides: Partial<ViewSwitchedPayload> = {},
): ViewSwitchedPayload {
  return {
    viewId: "wallet",
    viewLabel: "Wallet",
    initiatedBy: "user",
    ...overrides,
  } as ViewSwitchedPayload;
}

describe("buildProactiveJudgePrompt — intent-bearing view", () => {
  it("includes the declared intent, purpose, and live state", () => {
    const prompt = buildProactiveJudgePrompt(
      viewSwitch({
        anticipatoryIntent:
          "offer a portfolio summary and a fund/swap next step",
        viewPurpose: "Token inventory, NFTs, and P&L",
      }),
      "Live wallet state:\n- Token inventory: 3 assets.",
    );
    expect(prompt).toContain("Declared intent: offer a portfolio summary");
    expect(prompt).toContain("Purpose: Token inventory");
    expect(prompt).toContain("Live wallet state:");
    expect(prompt).toContain("3 assets");
  });
});

describe("buildProactiveJudgePrompt — no-intent view", () => {
  it("falls back to a label-only description that permits silence", () => {
    const prompt = buildProactiveJudgePrompt(
      viewSwitch({ viewId: "database" }),
    );
    expect(prompt).toContain('opened the "Wallet" view');
    expect(prompt).toContain("Declared intent: none");
    expect(prompt).toContain("stay silent unless something is clearly useful");
    expect(prompt).toContain("Live view state: none available");
  });
});

describe("parseProactiveJudgeDecisionOutput — confidence floor", () => {
  it("suppresses a low-confidence offer on a no-intent view", () => {
    const out = parseProactiveJudgeDecisionOutput(
      JSON.stringify({ comment: "Want a hand?", confidence: 0.4 }),
    );
    expect(out).toBeNull();
  });

  it("admits a scoped greeting on an intent-bearing view despite low confidence", () => {
    const out = parseProactiveJudgeDecisionOutput(
      JSON.stringify({
        comment: "You have 3 assets — want a portfolio summary?",
        confidence: 0.4,
      }),
      { hasDeclaredIntent: true },
    );
    expect(out).not.toBeNull();
    expect(out?.text).toContain("portfolio summary");
  });

  it("still rejects an explicit null comment even on intent-bearing views", () => {
    const out = parseProactiveJudgeDecisionOutput(
      JSON.stringify({ comment: null, confidence: 0.9 }),
      { hasDeclaredIntent: true },
    );
    expect(out).toBeNull();
  });
});
