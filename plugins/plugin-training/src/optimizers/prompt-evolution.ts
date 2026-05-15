/**
 * GEPA-style genetic prompt evolution.
 *
 * Maintains a population of candidate prompts. Each generation:
 *   1. Score every candidate on a held-out subset.
 *   2. Select the top half as survivors.
 *   3. For each survivor, with probability `mutationRate`, ask the LLM to
 *      rewrite a slice (intro/rules/example) to produce a child.
 *   4. Re-fill the population with mutated children of the survivors.
 *
 * The optimizer always preserves the all-time best prompt so an unlucky
 * generation cannot regress past the baseline.
 */

import { subsample } from "./scoring.js";
import type {
  LlmAdapter,
  OptimizationExample,
  OptimizerLineageEntry,
  OptimizerResult,
  PromptScorer,
} from "./types.js";

export interface PromptEvolutionOptions {
  /** Population size. Defaults to 8. */
  population?: number;
  /** Generations. Defaults to 4. */
  generations?: number;
  /** Probability of mutating a survivor each generation. Defaults to 0.5. */
  mutationRate?: number;
  /** Held-out examples scored per candidate. Defaults to all examples. */
  scoringSubset?: number;
  /** Sampling temperature for mutation generation. Defaults to 0.8. */
  temperature?: number;
  /** Max tokens for the mutation completion. Defaults to 1024. */
  maxTokens?: number;
  /** Deterministic RNG override (tests). Defaults to Math.random. */
  rng?: () => number;
}

export interface PromptEvolutionInput {
  baselinePrompt: string;
  dataset: OptimizationExample[];
  scorer: PromptScorer;
  llm: LlmAdapter;
  options?: PromptEvolutionOptions;
}

const MUTATION_INSTRUCTIONS = `You are a prompt engineer. Mutate the SYSTEM PROMPT below to explore a different phrasing.

Constraints:
- Preserve the original task contract (inputs, outputs, format).
- Keep all literal placeholders like {{agentName}} or {{providers}} intact.
- Pick ONE section (intro, rules, examples, output format) and rewrite it.
- Leave the other sections untouched, but reproduce them verbatim in the output.
- Output ONLY the mutated prompt. No commentary, no fenced code blocks.`;

interface ScoredPrompt {
  prompt: string;
  score: number;
}

export async function runPromptEvolution(
  input: PromptEvolutionInput,
): Promise<OptimizerResult> {
  const population = Math.max(2, input.options?.population ?? 8);
  const generations = input.options?.generations ?? 4;
  const mutationRate = input.options?.mutationRate ?? 0.5;
  const temperature = input.options?.temperature ?? 0.8;
  const maxTokens = input.options?.maxTokens ?? 1024;
  const rng = input.options?.rng ?? Math.random;
  const lineage: OptimizerLineageEntry[] = [];

  const heldOut =
    typeof input.options?.scoringSubset === "number"
      ? subsample(input.dataset, input.options.scoringSubset, rng)
      : input.dataset;

  const baselineScore = await input.scorer(input.baselinePrompt, heldOut);
  lineage.push({
    round: 0,
    variant: 0,
    score: baselineScore,
    notes: "baseline",
  });

  // Seed the population with mutations of the baseline so generation 0 is
  // already diverse. The baseline itself stays at index 0 so the elite is
  // always preserved.
  let pool: ScoredPrompt[] = [
    { prompt: input.baselinePrompt, score: baselineScore },
  ];
  for (let i = 1; i < population; i += 1) {
    const seed = await mutate(input.llm, input.baselinePrompt, {
      temperature,
      maxTokens,
    });
    const score = await input.scorer(seed, heldOut);
    pool.push({ prompt: seed, score });
    lineage.push({ round: 0, variant: i, score, notes: "seed mutation" });
  }

  let bestPrompt = input.baselinePrompt;
  let bestScore = baselineScore;
  for (const entry of pool) {
    if (entry.score > bestScore) {
      bestScore = entry.score;
      bestPrompt = entry.prompt;
    }
  }

  for (let gen = 1; gen <= generations; gen += 1) {
    pool.sort((a, b) => b.score - a.score);
    const cutoff = Math.max(1, Math.floor(pool.length / 2));
    const survivors = pool.slice(0, cutoff);
    const next: ScoredPrompt[] = [...survivors];

    let variantIdx = survivors.length;
    while (next.length < population) {
      const parent = survivors[next.length % survivors.length];
      if (!parent) break;
      const shouldMutate = rng() < mutationRate;
      let childPrompt = parent.prompt;
      if (shouldMutate) {
        childPrompt = await mutate(input.llm, parent.prompt, {
          temperature,
          maxTokens,
        });
      }
      const score = await input.scorer(childPrompt, heldOut);
      next.push({ prompt: childPrompt, score });
      lineage.push({
        round: gen,
        variant: variantIdx,
        score,
        notes: shouldMutate ? "mutated child" : "carried forward",
      });
      variantIdx += 1;
    }

    pool = next;
    for (const entry of pool) {
      if (entry.score > bestScore) {
        bestScore = entry.score;
        bestPrompt = entry.prompt;
      }
    }
  }

  return {
    optimizedPrompt: bestPrompt,
    score: bestScore,
    baseline: baselineScore,
    lineage,
  };
}

async function mutate(
  llm: LlmAdapter,
  prompt: string,
  settings: { temperature: number; maxTokens: number },
): Promise<string> {
  const result = await llm.complete({
    system: MUTATION_INSTRUCTIONS,
    user: prompt,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
  });
  const cleaned = result.trim();
  return cleaned.length > 0 ? cleaned : prompt;
}
