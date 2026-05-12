/**
 * Formal GEPA tests.
 *
 * Deterministic in-memory LlmAdapter — routes by system-prompt prefix:
 *   - SYS_REFLECT  → canned diagnostic naming the GOOD trigger.
 *   - SYS_FEEDBACK → prepends "GOOD" to the prompt.
 *   - SYS_COMPRESS → collapses blank lines.
 *   - SYS_CROSSOVER → concatenates the two inputs.
 *   - Otherwise (task LLM during scoring) → emits "GOOD answer" when the
 *     system prompt contains GOOD, "BAD answer" otherwise.
 *
 * Scorer = 1 when output contains expected token (GOOD), else 0. Baseline
 * scores 0; mutated children score 1.
 */

import { describe, expect, it } from "vitest";
import { paretoFrontier, runGepa } from "../gepa.js";
import type {
  LlmAdapter,
  OptimizationExample,
  PromptScorer,
} from "../types.js";

function makeAdapter(): LlmAdapter {
  return {
    async complete(input) {
      const system = input.system ?? "";
      if (system.startsWith("You are diagnosing")) {
        return "Prompt fails to require GOOD outputs. Add the word GOOD.";
      }
      if (system.startsWith("You are a prompt engineer revising")) {
        const prompt =
          input.user.split("Current prompt:\n")[1]?.split("\n\nFailure analysis:")[0] ??
          input.user;
        return `GOOD\n${prompt}`;
      }
      if (system.startsWith("You are a prompt engineer reducing")) {
        return input.user.replace(/\n{2,}/g, "\n").trim();
      }
      if (system.startsWith("You are a prompt engineer merging")) {
        const aMatch = /PROMPT A:\n([\s\S]*?)\n\nPROMPT B:/.exec(input.user);
        const bMatch = /PROMPT B:\n([\s\S]*)$/.exec(input.user);
        return `${aMatch?.[1] ?? ""}\n${bMatch?.[1] ?? ""}`.trim();
      }
      return system.includes("GOOD") ? "GOOD answer" : "BAD answer";
    },
  };
}

function makeScorer(): PromptScorer {
  return async (prompt, examples) => {
    if (examples.length === 0) return 0;
    const adapter = makeAdapter();
    let total = 0;
    for (const ex of examples) {
      const out = await adapter.complete({
        system: prompt,
        user: ex.input.user,
        temperature: 0,
      });
      if (out.includes(ex.expectedOutput)) total += 1;
    }
    return total / examples.length;
  };
}

function makeDataset(n: number): OptimizationExample[] {
  return Array.from({ length: n }, (_unused, i) => ({
    id: `row-${i}`,
    input: { user: `question ${i}` },
    expectedOutput: "GOOD",
  }));
}

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("runGepa", () => {
  it("improves a known-bad baseline on a synthetic task", async () => {
    const result = await runGepa({
      baselinePrompt: "respond to the user",
      dataset: makeDataset(4),
      scorer: makeScorer(),
      llm: makeAdapter(),
      options: {
        population: 4,
        generations: 2,
        reflectionBatchSize: 2,
        rng: seededRng(11),
      },
    });
    expect(result.baseline).toBe(0);
    expect(result.score).toBeGreaterThan(result.baseline);
    expect(result.optimizedPrompt).toContain("GOOD");
  });

  it("records lineage with feedback excerpts", async () => {
    const result = await runGepa({
      baselinePrompt: "respond to the user",
      dataset: makeDataset(3),
      scorer: makeScorer(),
      llm: makeAdapter(),
      options: {
        population: 3,
        generations: 1,
        reflectionBatchSize: 1,
        rng: seededRng(3),
      },
    });
    expect(result.lineage[0]?.notes).toBe("baseline");
    const withFeedback = result.lineage.filter((e) =>
      (e.notes ?? "").includes("|"),
    );
    expect(withFeedback.length).toBeGreaterThan(0);
    const hasExcerpt = withFeedback.some((e) => {
      const after = (e.notes ?? "").split(" | ")[1] ?? "";
      return after.trim().length > 0;
    });
    expect(hasExcerpt).toBe(true);
  });

  it("Pareto frontier keeps non-dominated candidates only", () => {
    // {0.5,100} dominated by {0.8,50} (better on both); {0.8,80} dominated
    // by {0.8,50} (equal score, fewer tokens). Survivors: B and C.
    const pool = [
      { prompt: "A", score: 0.5, tokens: 100, feedback: "", origin: "x" },
      { prompt: "B", score: 0.8, tokens: 50, feedback: "", origin: "x" },
      { prompt: "C", score: 1.0, tokens: 200, feedback: "", origin: "x" },
      { prompt: "D", score: 0.8, tokens: 80, feedback: "", origin: "x" },
    ];
    const frontier = paretoFrontier(pool);
    const prompts = frontier.map((c) => c.prompt).sort();
    expect(prompts).toEqual(["B", "C"]);
  });

  it("degrades gracefully on tiny datasets (< 3 rows)", async () => {
    const result = await runGepa({
      baselinePrompt: "respond to the user",
      dataset: makeDataset(1),
      scorer: makeScorer(),
      llm: makeAdapter(),
      options: {
        population: 2,
        generations: 1,
        reflectionBatchSize: 1,
        rng: seededRng(2),
      },
    });
    expect(typeof result.optimizedPrompt).toBe("string");
    expect(result.optimizedPrompt.length).toBeGreaterThan(0);
    expect(result.score).toBeGreaterThanOrEqual(result.baseline);
    expect(Array.isArray(result.lineage)).toBe(true);
    expect(result.lineage.length).toBeGreaterThan(0);
  });

  it("handles empty datasets without throwing", async () => {
    const result = await runGepa({
      baselinePrompt: "respond to the user",
      dataset: [],
      scorer: makeScorer(),
      llm: makeAdapter(),
      options: {
        population: 2,
        generations: 1,
        reflectionBatchSize: 1,
        rng: seededRng(1),
      },
    });
    expect(result.baseline).toBe(0);
    expect(result.score).toBe(0);
    expect(result.lineage.length).toBeGreaterThan(0);
  });
});
