/**
 * Prompt A/B comparison harness.
 *
 * Given two prompts (baseline + variant) and a dataset of historical
 * input/expected pairs, run each prompt through the same model and
 * report mean scores plus per-example deltas. Used to gate prompt
 * cleanup / compression changes before they ship: a variant that
 * regresses against the historical reference indicates a behavioral
 * change, not a pure cosmetic edit.
 *
 * The harness is a thin wrapper over the native optimizer scorer
 * (`createPromptScorer` from optimizers/scoring.ts) — that scorer is
 * already designed for prompt-vs-dataset evaluation, just with a
 * single prompt at a time. We invoke it twice and diff the results.
 *
 * Two scoring modes are supported:
 *
 * - `vs_historical` (default): each prompt is scored against the
 *   recorded `expectedOutput` (Jaccard token overlap by default,
 *   action-name match for the action_planner task). Cheap and
 *   deterministic. Both prompts are scored independently; the delta
 *   tells you whether the variant reproduces the historical output
 *   as well as the baseline does.
 *
 * - `pairwise`: run baseline on every example to capture v1 outputs,
 *   then run variant on the same inputs and compare v2 outputs to v1
 *   outputs directly (pairwise Jaccard). This answers "did the
 *   variant produce semantically equivalent output?", which is a
 *   stricter regression test than `vs_historical` because the latter
 *   is biased — historical outputs were likely produced by a prompt
 *   close to the baseline.
 *
 * No new model abstractions are introduced. Reuses:
 *   - `parseJsonlDataset()` from backends/native.ts (private — re-implemented inline here for now)
 *   - `createRuntimeAdapter()` from optimizers/scoring.ts
 *   - `createPromptScorer()` from optimizers/scoring.ts
 *   - `scoreAgreement()` / `scorePlannerAction()` from optimizers/scoring.ts
 *
 * Cost note: N examples × 2 prompts = 2N model calls per run in
 * `vs_historical` mode; same in `pairwise` mode (baseline outputs are
 * captured once, variant once). Default temperature 0 for determinism.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  createPromptScorer,
  createRuntimeAdapter,
  type LlmAdapter,
  type OptimizationExample,
  scoreAgreement,
  scorePlannerAction,
  type UseModelHandler,
} from "../optimizers/index.js";
import type { TrajectoryTrainingTask } from "./trajectory-task-datasets.js";

export type ScorerKind = "agreement" | "planner_action";
export type CompareMode = "vs_historical" | "pairwise";

export interface PromptComparisonInput {
  /** System prompt under test as the baseline (often the current canonical prompt). */
  baselinePrompt: string;
  /** System prompt under test as the variant (e.g. caveman-compressed). */
  variantPrompt: string;
  /** Dataset of `(input, expectedOutput)` rows. Path to a JSONL file produced by `exportTrajectoryTaskDatasets`, or an in-memory array. */
  dataset: string | OptimizationExample[];
  /** Task hint — selects the right scorer when `scorer` is omitted. Defaults to `agreement`. */
  task?: TrajectoryTrainingTask;
  /** Force a specific scorer regardless of task. */
  scorer?: ScorerKind;
  /** Cap how many examples to score (handy for cheap previews). */
  maxExamples?: number;
  /** Compare mode: `vs_historical` (default) or `pairwise`. */
  mode?: CompareMode;
  /** Temperature passed to the adapter. Defaults to 0 for determinism. */
  temperature?: number;
  /** Max tokens per completion. Defaults to 512. */
  maxTokens?: number;
  /** Loose runtime shape — only `useModel` is required. Mutually exclusive with `adapter`. */
  runtime?: { useModel: UseModelHandler };
  /** Pre-built LLM adapter (tests, alternative providers). */
  adapter?: LlmAdapter;
}

export interface PromptComparisonResult {
  baselineScore: number;
  variantScore: number;
  /** `variantScore - baselineScore`. Positive means variant is closer to reference. */
  delta: number;
  /** Percentage delta, where 0 baseline collapses to 0 to avoid divide-by-zero. */
  deltaPercent: number;
  examplesScored: number;
  scorer: ScorerKind;
  mode: CompareMode;
  /** True when the variant did not measurably regress (delta ≥ -tolerance). */
  passed: boolean;
  /** Tolerance applied to `passed`. Defaults to 0.02 (2 percentage points). */
  tolerance: number;
}

/** Default tolerance: a variant is considered safe if its score is within
 *  2 percentage points of the baseline. Tunable per call. */
export const DEFAULT_REGRESSION_TOLERANCE = 0.02;

/**
 * Compare two prompts on the same dataset and report mean scores plus
 * delta. Throws on dataset I/O errors; never throws for "variant is
 * worse" — read `result.passed` for the gate decision.
 */
export async function comparePrompts(
  input: PromptComparisonInput,
): Promise<PromptComparisonResult> {
  const examples = loadDataset(input.dataset);
  const cap =
    typeof input.maxExamples === "number" && input.maxExamples > 0
      ? Math.min(input.maxExamples, examples.length)
      : examples.length;
  const limited = examples.slice(0, cap);

  if (limited.length === 0) {
    return emptyResult(input);
  }

  const adapter = resolveAdapter(input);
  const scorerKind: ScorerKind =
    input.scorer ??
    (input.task === "action_planner" ? "planner_action" : "agreement");
  const compare =
    scorerKind === "planner_action" ? scorePlannerAction : scoreAgreement;
  const mode: CompareMode = input.mode ?? "vs_historical";

  if (mode === "pairwise") {
    return runPairwise({
      adapter,
      baselinePrompt: input.baselinePrompt,
      variantPrompt: input.variantPrompt,
      examples: limited,
      compare,
      scorerKind,
      temperature: input.temperature ?? 0,
      maxTokens: input.maxTokens ?? 512,
      tolerance: DEFAULT_REGRESSION_TOLERANCE,
    });
  }

  const scorer = createPromptScorer(adapter, {
    compare,
    temperature: input.temperature ?? 0,
    maxTokens: input.maxTokens ?? 512,
  });
  const baselineScore = await scorer(input.baselinePrompt, limited);
  const variantScore = await scorer(input.variantPrompt, limited);

  return finalize({
    baselineScore,
    variantScore,
    examplesScored: limited.length,
    scorerKind,
    mode,
    tolerance: DEFAULT_REGRESSION_TOLERANCE,
  });
}

function loadDataset(
  dataset: string | OptimizationExample[],
): OptimizationExample[] {
  if (typeof dataset !== "string") return dataset;
  if (!existsSync(dataset)) {
    throw new Error(`[prompt-compare] dataset not found at ${dataset}`);
  }
  const raw = readFileSync(dataset, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const examples: OptimizationExample[] = [];
  let index = 0;
  for (const line of lines) {
    const example = jsonlLineToExample(line, index);
    if (example) examples.push(example);
    index += 1;
  }
  return examples;
}

interface JsonlMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
}

interface JsonlRow {
  format?: string;
  request?: { system?: string; prompt?: string; messages?: JsonlMessage[] };
  response?: { text?: string; toolCalls?: unknown[] };
}

/** Parse one `eliza_native_v1` row to an OptimizationExample. Mirrors
 *  `rowToExample()` in backends/native.ts; copied here to avoid an
 *  import cycle and to accept rows that don't carry the `boundary`
 *  field (older exports). */
function jsonlLineToExample(
  line: string,
  index: number,
): OptimizationExample | null {
  let parsed: JsonlRow;
  try {
    parsed = JSON.parse(line) as JsonlRow;
  } catch {
    return null;
  }
  let system: string | undefined;
  let user: string | undefined;
  let expected: string | undefined;
  if (typeof parsed.request?.system === "string" && parsed.request.system) {
    system = parsed.request.system;
  }
  for (const msg of parsed.request?.messages ?? []) {
    if (!system && msg.role === "system" && typeof msg.content === "string") {
      system = msg.content;
    }
    if (msg.role === "user" && typeof msg.content === "string") {
      user = user ? `${user}\n${msg.content}` : msg.content;
    }
    if (msg.role === "assistant" && typeof msg.content === "string") {
      expected = msg.content;
    }
  }
  if (!user && typeof parsed.request?.prompt === "string") {
    user = parsed.request.prompt;
  }
  if (parsed.response) {
    if (typeof parsed.response.text === "string" && parsed.response.text) {
      expected = parsed.response.text;
    } else if (Array.isArray(parsed.response.toolCalls)) {
      expected = JSON.stringify({ toolCalls: parsed.response.toolCalls });
    }
  }
  if (!user || !expected) return null;
  return {
    id: `row-${index}`,
    input: { system, user },
    expectedOutput: expected,
  };
}

function resolveAdapter(input: PromptComparisonInput): LlmAdapter {
  if (input.adapter) return input.adapter;
  // Standing direction: training-side comparison runs on Cerebras
  // gpt-oss-120b unless the operator passes their own adapter.
  const trainProvider =
    process.env.TRAIN_MODEL_PROVIDER?.trim() ?? process.env.TRAINING_PROVIDER?.trim();
  if (trainProvider === "cerebras") {
    const { getTrainingUseModelAdapter } = require(
      "../../../app-lifeops/test/helpers/lifeops-eval-model.ts",
    ) as typeof import("../../../app-lifeops/test/helpers/lifeops-eval-model.ts");
    return createRuntimeAdapter(getTrainingUseModelAdapter());
  }
  if (!input.runtime) {
    throw new Error(
      "[prompt-compare] either `runtime` or `adapter` must be provided",
    );
  }
  return createRuntimeAdapter(input.runtime.useModel);
}

interface PairwiseInput {
  adapter: LlmAdapter;
  baselinePrompt: string;
  variantPrompt: string;
  examples: OptimizationExample[];
  compare: (actual: string, expected: string) => number;
  scorerKind: ScorerKind;
  temperature: number;
  maxTokens: number;
  tolerance: number;
}

/** Pairwise mode: capture baseline outputs, then compare variant
 *  outputs to those captured baselines. Both `baselineScore` and
 *  `variantScore` are reported as similarity-to-historical (same as
 *  vs_historical mode) so the two modes report a comparable axis;
 *  `delta` here additionally reflects mean pairwise self-similarity
 *  via the same compare function, which is its strength as a
 *  regression test. */
async function runPairwise(
  input: PairwiseInput,
): Promise<PromptComparisonResult> {
  let baselineToReference = 0;
  let variantToReference = 0;
  let variantToBaseline = 0;
  for (const example of input.examples) {
    const baselineOutput = await input.adapter.complete({
      system: input.baselinePrompt,
      user: example.input.user,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    });
    const variantOutput = await input.adapter.complete({
      system: input.variantPrompt,
      user: example.input.user,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    });
    baselineToReference += input.compare(baselineOutput, example.expectedOutput);
    variantToReference += input.compare(variantOutput, example.expectedOutput);
    variantToBaseline += input.compare(variantOutput, baselineOutput);
  }
  const n = input.examples.length;
  const baselineScore = baselineToReference / n;
  const variantScore = variantToReference / n;
  const result = finalize({
    baselineScore,
    variantScore,
    examplesScored: n,
    scorerKind: input.scorerKind,
    mode: "pairwise",
    tolerance: input.tolerance,
  });
  // Replace delta with the pairwise self-similarity signal; deltaPercent
  // becomes the gap between variant→baseline similarity and 1.0.
  const pairwise = variantToBaseline / n;
  return {
    ...result,
    delta: pairwise - 1,
    deltaPercent: (pairwise - 1) * 100,
    passed: pairwise + input.tolerance >= 1,
  };
}

interface FinalizeInput {
  baselineScore: number;
  variantScore: number;
  examplesScored: number;
  scorerKind: ScorerKind;
  mode: CompareMode;
  tolerance: number;
}

function finalize(input: FinalizeInput): PromptComparisonResult {
  const delta = input.variantScore - input.baselineScore;
  const deltaPercent =
    input.baselineScore === 0 ? 0 : (delta / input.baselineScore) * 100;
  return {
    baselineScore: input.baselineScore,
    variantScore: input.variantScore,
    delta,
    deltaPercent,
    examplesScored: input.examplesScored,
    scorer: input.scorerKind,
    mode: input.mode,
    passed: delta + input.tolerance >= 0,
    tolerance: input.tolerance,
  };
}

function emptyResult(input: PromptComparisonInput): PromptComparisonResult {
  const scorer: ScorerKind =
    input.scorer ??
    (input.task === "action_planner" ? "planner_action" : "agreement");
  return {
    baselineScore: 0,
    variantScore: 0,
    delta: 0,
    deltaPercent: 0,
    examplesScored: 0,
    scorer,
    mode: input.mode ?? "vs_historical",
    passed: true,
    tolerance: DEFAULT_REGRESSION_TOLERANCE,
  };
}

/** Render a result as a single-line summary suitable for CLI output. */
export function formatComparisonSummary(
  result: PromptComparisonResult,
): string {
  const sign = result.delta >= 0 ? "+" : "";
  const verdict = result.passed ? "PASS" : "FAIL";
  return [
    `[prompt-compare] ${verdict} mode=${result.mode} scorer=${result.scorer}`,
    `n=${result.examplesScored}`,
    `baseline=${result.baselineScore.toFixed(4)}`,
    `variant=${result.variantScore.toFixed(4)}`,
    `delta=${sign}${result.delta.toFixed(4)} (${sign}${result.deltaPercent.toFixed(2)}%)`,
    `tolerance=${result.tolerance}`,
  ].join(" ");
}
