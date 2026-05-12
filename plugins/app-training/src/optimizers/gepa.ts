/**
 * Formal GEPA optimizer (Goyal et al. 2024, https://arxiv.org/abs/2407.10718).
 *
 * Distinct from `prompt-evolution.ts` (plain genetic mutation):
 *   1. Reflective feedback — each generation the LLM is shown
 *      (prompt, predicted, expected) and asked WHY it failed. The diagnostic
 *      text feeds the next mutation step.
 *   2. Pareto-frontier selection over (score, prompt_token_count). Survivors
 *      are the non-dominated set, not the score top-half.
 *   3. Two mutation flavors per survivor: feedback-guided rewrite and
 *      token-compression rewrite.
 *   4. Crossover step — top two by score merged via LLM.
 *
 * Returns the best-score candidate from the final Pareto frontier. Ties on
 * score broken by fewer tokens. Lineage records (round, variant, score,
 * feedback excerpt) so OptimizedPromptArtifact consumes it transparently.
 */

import { subsample } from "./scoring.js";
import type {
  LlmAdapter,
  OptimizationExample,
  OptimizerLineageEntry,
  OptimizerResult,
  PromptScorer,
} from "./types.js";

export interface GepaOptions {
  /** Population size. Defaults to 12. */
  population?: number;
  /** Generations. Defaults to 8. */
  generations?: number;
  /** Held-out examples scored per candidate. Defaults to all examples. */
  scoringSubset?: number;
  /** Examples shown per reflection call. Defaults to 3. */
  reflectionBatchSize?: number;
  /** Mutation sampling temperature. Defaults to 0.8. */
  temperature?: number;
  /** Reflection sampling temperature. Defaults to 0.4. */
  reflectionTemperature?: number;
  /** Mutation completion max tokens. Defaults to 1024. */
  maxTokens?: number;
  /** Reflection completion max tokens. Defaults to 512. */
  reflectionMaxTokens?: number;
  /** Enable crossover step. Defaults to true. */
  crossover?: boolean;
  /** Deterministic RNG (tests). Defaults to Math.random. */
  rng?: () => number;
}

export interface GepaInput {
  baselinePrompt: string;
  dataset: OptimizationExample[];
  scorer: PromptScorer;
  llm: LlmAdapter;
  options?: GepaOptions;
}

const SYS_FEEDBACK = `You are a prompt engineer revising a SYSTEM PROMPT based on observed failure analysis.

You will receive the current prompt and a short feedback note explaining what went wrong. Produce a revised prompt that addresses the feedback. Preserve the task contract (inputs, outputs, format) and every literal placeholder ({{agentName}}, {{providers}}, etc.) byte-identical. Output only the revised prompt body. No commentary, no fenced code blocks.`;

const SYS_COMPRESS = `You are a prompt engineer reducing a SYSTEM PROMPT to its essentials.

Rewrite the prompt below shorter while preserving every contract guarantee. Drop redundant phrasing, collapse parallel rules, remove decorative bullets and meta-commentary. Keep every literal placeholder byte-identical. Output only the revised prompt body. No commentary, no fenced code blocks.`;

const SYS_CROSSOVER = `You are a prompt engineer merging two candidate SYSTEM PROMPTS.

You will receive PROMPT A and PROMPT B. Produce a single prompt that takes the strongest guidance from each. Preserve the task contract and every literal placeholder. Do not exceed 1.2x the longer parent's character count. Output only the merged prompt body. No commentary, no fenced code blocks.`;

const SYS_REFLECT = `You are diagnosing why a SYSTEM PROMPT is failing.

You will receive the current prompt and a small batch of examples: each shows the user input, the model's actual output, and the expected output. Write a SHORT diagnostic (max 4 sentences) naming the concrete failure mode and a specific change to the prompt that would fix it. No filler. No restatement of the prompt. No fenced code blocks. Output plain text only.`;

interface Candidate {
  prompt: string;
  score: number;
  tokens: number;
  feedback: string;
  origin: string;
}

interface Ctx {
  llm: LlmAdapter;
  scorer: PromptScorer;
  heldOut: OptimizationExample[];
  reflectionBatchSize: number;
  temperature: number;
  reflectionTemperature: number;
  maxTokens: number;
  reflectionMaxTokens: number;
}

export async function runGepa(input: GepaInput): Promise<OptimizerResult> {
  const population = Math.max(2, input.options?.population ?? 12);
  const generations = input.options?.generations ?? 8;
  const rng = input.options?.rng ?? Math.random;
  const lineage: OptimizerLineageEntry[] = [];
  const heldOut =
    typeof input.options?.scoringSubset === "number"
      ? subsample(input.dataset, input.options.scoringSubset, rng)
      : input.dataset;
  const ctx: Ctx = {
    llm: input.llm,
    scorer: input.scorer,
    heldOut,
    reflectionBatchSize: Math.max(1, input.options?.reflectionBatchSize ?? 3),
    temperature: input.options?.temperature ?? 0.8,
    reflectionTemperature: input.options?.reflectionTemperature ?? 0.4,
    maxTokens: input.options?.maxTokens ?? 1024,
    reflectionMaxTokens: input.options?.reflectionMaxTokens ?? 512,
  };
  const enableCrossover = input.options?.crossover ?? true;

  const baseline = await scoreCandidate(
    ctx,
    input.baselinePrompt,
    "baseline",
    0,
    0,
    lineage,
  );
  let pool: Candidate[] = [baseline];

  // Seed: alternate feedback-guided and compression mutations of the baseline.
  for (let i = 1; i < population; i += 1) {
    const mode: "feedback" | "compress" = i % 2 === 0 ? "compress" : "feedback";
    const seed = await mutate(ctx, input.baselinePrompt, baseline.feedback, mode);
    pool.push(
      await scoreCandidate(ctx, seed, `seed-${mode}`, 0, i, lineage),
    );
  }

  for (let gen = 1; gen <= generations; gen += 1) {
    const frontier = paretoFrontier(pool);
    const next: Candidate[] = [...frontier];
    let variantIdx = next.length;

    // K=2 children per survivor: one feedback-guided, one compression.
    for (const parent of frontier) {
      if (next.length >= population) break;
      const child = await mutate(ctx, parent.prompt, parent.feedback, "feedback");
      next.push(
        await scoreCandidate(ctx, child, "feedback-mut", gen, variantIdx++, lineage),
      );
      if (next.length >= population) break;
      const comp = await mutate(ctx, parent.prompt, "", "compress");
      next.push(
        await scoreCandidate(ctx, comp, "compress-mut", gen, variantIdx++, lineage),
      );
    }

    // Crossover: merge the top two on the frontier when budget remains.
    if (enableCrossover && next.length < population && frontier.length >= 2) {
      const [a, b] = [...frontier].sort((x, y) => y.score - x.score);
      if (a && b && a.prompt !== b.prompt) {
        const merged = await llmCall(
          ctx.llm,
          SYS_CROSSOVER,
          `PROMPT A:\n${a.prompt}\n\nPROMPT B:\n${b.prompt}`,
          ctx.temperature,
          ctx.maxTokens,
          a.prompt,
        );
        next.push(
          await scoreCandidate(ctx, merged, "crossover", gen, variantIdx++, lineage),
        );
      }
    }

    pool = next;
  }

  const finalFrontier = paretoFrontier(pool);
  const best = finalFrontier.reduce<Candidate>((acc, cur) => {
    if (cur.score > acc.score) return cur;
    if (cur.score === acc.score && cur.tokens < acc.tokens) return cur;
    return acc;
  }, finalFrontier[0] ?? pool[0]!);

  return {
    optimizedPrompt: best.prompt,
    score: best.score,
    baseline: baseline.score,
    lineage,
  };
}

/**
 * Score a candidate prompt, run reflection on it, push lineage, and return
 * the populated Candidate. Centralized so seed / generation / crossover
 * paths share identical bookkeeping.
 */
async function scoreCandidate(
  ctx: Ctx,
  prompt: string,
  origin: string,
  round: number,
  variant: number,
  lineage: OptimizerLineageEntry[],
): Promise<Candidate> {
  const score = await ctx.scorer(prompt, ctx.heldOut);
  const feedback = await reflect(ctx, prompt);
  const tokens = approxTokenCount(prompt);
  const note =
    origin === "baseline"
      ? "baseline"
      : origin === "compress-mut" || origin === "seed-compress"
        ? `${origin} | tokens=${tokens}`
        : `${origin} | ${truncate(feedback, 120)}`;
  lineage.push({ round, variant, score, notes: note });
  return { prompt, score, tokens, feedback, origin };
}

async function mutate(
  ctx: Ctx,
  prompt: string,
  feedback: string,
  mode: "feedback" | "compress",
): Promise<string> {
  if (mode === "compress") {
    return llmCall(
      ctx.llm,
      SYS_COMPRESS,
      prompt,
      ctx.temperature,
      ctx.maxTokens,
      prompt,
    );
  }
  const user = `Current prompt:\n${prompt}\n\nFailure analysis:\n${feedback || "(none provided — explore a phrasing change)"}`;
  return llmCall(ctx.llm, SYS_FEEDBACK, user, ctx.temperature, ctx.maxTokens, prompt);
}

/**
 * Run the prompt against a small batch of examples, then ask the LLM to
 * diagnose what went wrong. The diagnostic feeds the next mutation step —
 * this is the "reflective evolution" half of GEPA.
 */
async function reflect(ctx: Ctx, prompt: string): Promise<string> {
  if (ctx.heldOut.length === 0) return "";
  const batch = ctx.heldOut.slice(0, ctx.reflectionBatchSize);
  const transcripts: string[] = [];
  for (let i = 0; i < batch.length; i += 1) {
    const ex = batch[i]!;
    const actual = await ctx.llm.complete({
      system: prompt,
      user: ex.input.user,
      temperature: 0,
      maxTokens: 256,
    });
    transcripts.push(
      `Example ${i + 1}:\nUser: ${truncate(ex.input.user, 400)}\nActual: ${truncate(actual, 400)}\nExpected: ${truncate(ex.expectedOutput, 400)}`,
    );
  }
  const user = `Prompt:\n${prompt}\n\n${transcripts.join("\n\n")}`;
  return llmCall(
    ctx.llm,
    SYS_REFLECT,
    user,
    ctx.reflectionTemperature,
    ctx.reflectionMaxTokens,
    "",
  );
}

async function llmCall(
  llm: LlmAdapter,
  system: string,
  user: string,
  temperature: number,
  maxTokens: number,
  fallback: string,
): Promise<string> {
  const result = await llm.complete({ system, user, temperature, maxTokens });
  const cleaned = result.trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Pareto frontier over (score asc, tokens asc): a candidate is dominated when
 * another has strictly higher score AND fewer-or-equal tokens, or
 * higher-or-equal score AND strictly fewer tokens.
 */
export function paretoFrontier(pool: Candidate[]): Candidate[] {
  const frontier: Candidate[] = [];
  for (const cur of pool) {
    let dominated = false;
    for (const other of pool) {
      if (other === cur) continue;
      const strictlyBetterScore = other.score > cur.score;
      const strictlyFewerTokens = other.tokens < cur.tokens;
      const noWorseScore = other.score >= cur.score;
      const noMoreTokens = other.tokens <= cur.tokens;
      if (
        (strictlyBetterScore && noMoreTokens) ||
        (noWorseScore && strictlyFewerTokens)
      ) {
        dominated = true;
        break;
      }
    }
    if (!dominated && !frontier.some((c) => c.prompt === cur.prompt)) {
      frontier.push(cur);
    }
  }
  return frontier;
}

/**
 * Cheap token-count proxy: whitespace word count + half the punctuation
 * count. Good enough for relative Pareto comparisons; never persisted.
 */
function approxTokenCount(text: string): number {
  if (text.length === 0) return 0;
  const words = text.trim().split(/\s+/).filter((s) => s.length > 0).length;
  const puncts = (text.match(/[.,;:!?(){}\[\]"'`]/g) ?? []).length;
  return words + Math.floor(puncts / 2);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
