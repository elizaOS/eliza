/**
 * Coverage for the LifeOps context-budget benchmark primitive (#8795 item 8):
 * per-provider token measurement, per-turn budget assertion, and the ablation
 * harness — all deterministic / credential-free.
 */
import { describe, expect, it } from "vitest";
import {
  ablateProviders,
  estimateTokens,
  LIFEOPS_CONTEXT_PROVIDERS,
  measureProviderPayloads,
  summarizeContextBudget,
} from "./helpers/lifeops-context-budget.js";

const payloads = {
  lifeops: "x".repeat(400), // 100 tokens
  inboxTriage: "y".repeat(200), // 50 tokens
  pendingPrompts: "z".repeat(40), // 10 tokens
};

describe("LifeOps context-budget", () => {
  it("names the 10 planner context providers", () => {
    expect(LIFEOPS_CONTEXT_PROVIDERS).toHaveLength(10);
    expect(LIFEOPS_CONTEXT_PROVIDERS).toContain("lifeops");
    expect(LIFEOPS_CONTEXT_PROVIDERS).toContain("lifeops-health");
  });

  it("estimates tokens at ~4 chars/token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("x".repeat(401))).toBe(101);
  });

  it("measures and attributes per-provider payload, heaviest first", () => {
    const measured = measureProviderPayloads(payloads);
    expect(measured[0]?.name).toBe("lifeops");
    expect(measured[0]?.tokens).toBe(100);
    expect(measured[0]?.share).toBeCloseTo(100 / 160, 5);
    // sorted descending by tokens
    const tokens = measured.map((m) => m.tokens);
    expect(tokens).toEqual([...tokens].sort((a, b) => b - a));
  });

  it("flags an over-budget turn with a measured overflow", () => {
    const within = summarizeContextBudget(payloads, 200);
    expect(within.totalTokens).toBe(160);
    expect(within.withinBudget).toBe(true);
    expect(within.overflowTokens).toBe(0);

    const over = summarizeContextBudget(payloads, 120);
    expect(over.withinBudget).toBe(false);
    expect(over.overflowTokens).toBe(40);
  });

  it("ablates each provider and ranks contribution", async () => {
    // Synthetic scorer: accuracy proportional to whether `lifeops` is present
    // (its absence costs 0.5) plus a small contribution from inboxTriage (0.2).
    const score = (remaining: { name: string }[]): number => {
      const names = new Set(remaining.map((p) => p.name));
      return (
        (names.has("lifeops") ? 0.5 : 0) +
        (names.has("inboxTriage") ? 0.2 : 0) +
        0.3
      );
    };
    const { baselineScore, results } = await ablateProviders(payloads, score);
    expect(baselineScore).toBeCloseTo(1.0, 5);
    // lifeops contributes most (0.5), then inboxTriage (0.2), then pendingPrompts (0).
    expect(results[0]?.provider).toBe("lifeops");
    expect(results[0]?.deltaScore).toBeCloseTo(0.5, 5);
    expect(results[1]?.provider).toBe("inboxTriage");
    expect(results[1]?.deltaScore).toBeCloseTo(0.2, 5);
    expect(results[2]?.deltaScore).toBeCloseTo(0, 5);
  });
});
