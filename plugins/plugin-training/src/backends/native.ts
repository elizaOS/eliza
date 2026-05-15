/**
 * Native local-inference training backend.
 *
 * Dispatches a per-task JSONL dataset (produced by `dataset-generator.ts` /
 * `trajectory-task-datasets.ts`) through one of the native optimizers
 * (`instruction-search`, `prompt-evolution`, `bootstrap-fewshot`) and writes
 * the resulting artifact into the `~/.eliza/optimized-prompts/` store.
 *
 * Activation:
 *   bun run train -- --backend native --optimizer instruction-search \
 *     --dataset <path> --task <task>
 *
 * The backend is pure — it does not touch the network. It calls
 * `runtime.useModel(ModelType.TEXT_LARGE, …)` for variant generation and the
 * same model for scoring. Operators can swap the model via the optimizer
 * options without changing this file.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { TrajectoryTrainingTask } from "../core/trajectory-task-datasets.js";
import {
  buildDspyArtifact,
  buildExamplesFromRows,
  type DspyArtifactTask,
  type DspyOptimizerResult,
  defineSignature,
  legacyAdapterToLm,
  type Metric,
  runDspyBootstrapFewshot,
  runDspyCopro,
  runDspyMipro,
} from "../dspy/index.js";
import {
  createPromptScorer,
  createRuntimeAdapter,
  type LlmAdapter,
  type OptimizationExample,
  type OptimizerName,
  type OptimizerResult,
  type PromptScorer,
  runBootstrapFewshot,
  runGepa,
  runInstructionSearch,
  runPromptEvolution,
  scorePlannerAction,
  type UseModelHandler,
} from "../optimizers/index.js";

export interface NativeBackendOptions {
  /**
   * JSONL dataset produced by exportTrajectoryTaskDatasets. Each line is an
   * `eliza_native_v1` model-boundary row.
   */
  datasetPath: string;
  task: TrajectoryTrainingTask;
  optimizer: OptimizerName;
  /** Used for the artifact baseline + datasetId. */
  baselinePrompt: string;
  datasetId?: string;
  /** Loose runtime shape — only useModel is required. */
  runtime: { useModel: UseModelHandler };
  /** Override adapter (tests). */
  adapter?: LlmAdapter;
  /**
   * Fraction of the dataset reserved for the promotion gate's held-out
   * comparison (0..1). The split is deterministic via FNV-1a over each row's
   * stable id, so re-running the optimizer with the same dataset always
   * yields the same train/holdout partition. Set to 0 to disable splitting
   * (legacy behavior: optimizer and gate see the full dataset — vulnerable
   * to train-on-test contamination). Default: 0.2.
   */
  holdoutFraction?: number;
}

export const DEFAULT_HOLDOUT_FRACTION = 0.2;

export interface NativeBackendResult {
  invoked: boolean;
  optimizer: OptimizerName;
  task: TrajectoryTrainingTask;
  datasetSize: number;
  score: number;
  baselineScore: number;
  result: OptimizerResult;
  notes: string[];
  /**
   * Parsed examples from the JSONL dataset. Surfaced so callers (the
   * orchestrator's promotion gate) can re-score on the same data without
   * re-parsing the file.
   */
  dataset: OptimizationExample[];
  /**
   * Training subset the optimizer actually consumed. When `holdoutFraction>0`
   * this is a strict subset of `dataset`; when 0 it equals `dataset`.
   */
  trainSet: OptimizationExample[];
  /**
   * Held-out subset the optimizer never saw. The promotion gate scores
   * incumbent vs candidate on this set to avoid train-on-test contamination.
   * Empty when `holdoutFraction=0` or the deterministic split produced no
   * holdout rows (small datasets); callers fall back to `dataset` in that
   * case so the gate still has something to score against.
   */
  holdoutSet: OptimizationExample[];
  /**
   * Scorer instance used during optimization. Surfaced for the same reason as
   * `dataset` — the promotion gate runs the candidate against the incumbent
   * with the same scoring primitive (Jaccard or planner-action-match,
   * depending on the task).
   */
  scorer: PromptScorer;
}

/**
 * Deterministic 32-bit FNV-1a hash. Used to assign each example to
 * train/holdout in a reproducible way without keeping any state across runs.
 */
function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Split a dataset into train + holdout subsets deterministically by hashing
 * each row's `id` (falling back to position when missing). The fraction is
 * an upper bound — small datasets may produce 0 holdout rows, in which case
 * the caller should reuse the full dataset for gating.
 */
export function splitTrainHoldout(
  dataset: OptimizationExample[],
  holdoutFraction: number,
): { trainSet: OptimizationExample[]; holdoutSet: OptimizationExample[] } {
  if (holdoutFraction <= 0 || dataset.length < 2) {
    return { trainSet: dataset, holdoutSet: [] };
  }
  const fraction = Math.min(Math.max(holdoutFraction, 0), 0.5);
  const trainSet: OptimizationExample[] = [];
  const holdoutSet: OptimizationExample[] = [];
  const threshold = Math.floor(fraction * 0xffffffff);
  dataset.forEach((ex, index) => {
    const key = ex.id ?? `row-${index}`;
    const h = fnv1aHash(key);
    if (h < threshold) {
      holdoutSet.push(ex);
    } else {
      trainSet.push(ex);
    }
  });
  // Degenerate edge cases: ensure the optimizer always has at least one row,
  // and ensure the holdout has at least one row when the dataset is large
  // enough that the operator clearly expected a split.
  if (trainSet.length === 0 && holdoutSet.length > 0) {
    trainSet.push(holdoutSet.shift() as OptimizationExample);
  }
  if (holdoutSet.length === 0 && dataset.length >= 5) {
    holdoutSet.push(trainSet.pop() as OptimizationExample);
  }
  return { trainSet, holdoutSet };
}

interface JsonlMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
}

interface JsonlRow {
  format: "eliza_native_v1";
  boundary?: string;
  request?: {
    system?: string;
    prompt?: string;
    messages?: JsonlMessage[];
  };
  response?: {
    text?: string;
    toolCalls?: unknown[];
  };
}

function parseJsonlDataset(path: string): OptimizationExample[] {
  if (!existsSync(path)) {
    throw new Error(`[native-backend] dataset not found at ${path}`);
  }
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const examples: OptimizationExample[] = [];
  let index = 0;
  for (const line of lines) {
    const parsedJson: unknown = JSON.parse(line);
    if (!isJsonlRow(parsedJson)) {
      throw new Error(
        `[native-backend] dataset line ${index + 1} is not an eliza_native_v1 row`,
      );
    }
    const example = rowToExample(parsedJson, index);
    if (example) examples.push(example);
    index += 1;
  }
  return examples;
}

function isJsonlRow(value: unknown): value is JsonlRow {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as JsonlRow;
  return (
    candidate.format === "eliza_native_v1" &&
    (candidate.boundary === "vercel_ai_sdk.generateText" ||
      candidate.boundary === "vercel_ai_sdk.streamText")
  );
}

function rowToExample(
  row: JsonlRow,
  index: number,
): OptimizationExample | null {
  let system: string | undefined;
  let user: string | undefined;
  let expected: string | undefined;
  if (
    typeof row.request?.system === "string" &&
    row.request.system.length > 0
  ) {
    system = row.request.system;
  }
  const messages = row.request?.messages ?? [];
  for (const msg of messages) {
    if (!system && msg.role === "system" && typeof msg.content === "string") {
      system = msg.content;
    }
    if (msg.role === "user" && typeof msg.content === "string") {
      // Concatenate when multiple user turns appear; the trajectory
      // exporter already collapses these for single-turn tasks.
      user = user ? `${user}\n${msg.content}` : msg.content;
    }
    if (msg.role === "assistant" && typeof msg.content === "string") {
      expected = msg.content;
    }
  }
  if (!user && typeof row.request?.prompt === "string") {
    user = row.request.prompt;
  }
  if (row.response) {
    if (typeof row.response.text === "string" && row.response.text.length > 0) {
      expected = row.response.text;
    } else if (Array.isArray(row.response.toolCalls)) {
      expected = JSON.stringify({ toolCalls: row.response.toolCalls });
    }
  }
  if (!user || !expected) return null;
  return {
    id: `row-${index}`,
    input: { system, user },
    expectedOutput: expected,
  };
}

function dispatchOptimizer(
  optimizer: OptimizerName,
  input: {
    baselinePrompt: string;
    dataset: OptimizationExample[];
    scorer: ReturnType<typeof createPromptScorer>;
    llm: LlmAdapter;
    task: TrajectoryTrainingTask;
    datasetPath: string;
  },
): Promise<OptimizerResult> {
  switch (optimizer) {
    case "instruction-search":
      return runInstructionSearch(input);
    case "prompt-evolution":
      return runPromptEvolution(input);
    case "gepa":
      return runGepa(input);
    case "bootstrap-fewshot":
      return runBootstrapFewshot(input);
    case "dspy-bootstrap-fewshot":
    case "dspy-copro":
    case "dspy-mipro":
      return runDspyOptimizer(optimizer, input);
  }
}

/**
 * Bridge from the legacy (baselinePrompt + OptimizationExample[]) input shape
 * into the DSPy primitives: synthesize a Signature from the baseline + first
 * row, load examples through the privacy filter, and translate the resulting
 * DspyOptimizerResult back into the OptimizerResult contract used by the
 * native backend caller (and by `OptimizedPromptArtifact` consumers).
 */
async function runDspyOptimizer(
  optimizer: "dspy-bootstrap-fewshot" | "dspy-copro" | "dspy-mipro",
  input: {
    baselinePrompt: string;
    dataset: OptimizationExample[];
    scorer: ReturnType<typeof createPromptScorer>;
    llm: LlmAdapter;
    task: TrajectoryTrainingTask;
    datasetPath: string;
  },
): Promise<OptimizerResult> {
  // Re-load through the dspy loader so the privacy filter runs (mandatory per
  // CLAUDE.md — no path may skip it). We round-trip through the on-disk file
  // so the filter sees the original strings, then the optimizer consumes the
  // filtered Example[] only.
  const filtered = buildExamplesFromRows(
    input.dataset.map((ex) => ({
      format: "eliza_native_v1" as const,
      request: {
        system: ex.input.system,
        messages: [
          ...(ex.input.system
            ? [{ role: "system" as const, content: ex.input.system }]
            : []),
          { role: "user" as const, content: ex.input.user },
        ],
      },
      response: { text: ex.expectedOutput },
    })),
  );
  const examples = filtered.examples;
  if (examples.length === 0) {
    return {
      optimizedPrompt: input.baselinePrompt,
      score: 0,
      baseline: 0,
      lineage: [],
    };
  }

  const signature = defineSignature({
    name: `task_${input.task}`,
    instructions: input.baselinePrompt,
    inputs: [
      {
        name: "input",
        description: "User-turn text or planner input payload.",
        type: "string",
      },
    ],
    outputs: [
      {
        name: "output",
        description: "Expected response text for this task.",
        type: "string",
      },
    ],
  });

  // Exact-match metric on the canonical `output` field. The legacy backend
  // uses a Jaccard / planner-action scorer; we cannot reuse those here because
  // they take a baseline-prompt + dataset pair, not a (predicted, expected)
  // pair. Exact-match is the strict floor — when the model emits the same
  // string, score 1.
  const metric: Metric = (predicted, expected) => {
    const p = String(predicted.output ?? "").trim();
    const e = String(expected.output ?? "").trim();
    if (p.length === 0 || e.length === 0) return 0;
    return p === e ? 1 : 0;
  };

  const lm = legacyAdapterToLm(input.llm, "native-backend");
  let result: DspyOptimizerResult;
  if (optimizer === "dspy-bootstrap-fewshot") {
    result = await runDspyBootstrapFewshot({
      signature,
      dataset: examples,
      lm,
      metric,
    });
  } else if (optimizer === "dspy-copro") {
    result = await runDspyCopro({
      signature,
      dataset: examples,
      lm,
      metric,
    });
  } else {
    result = await runDspyMipro({
      signature,
      dataset: examples,
      lm,
      metric,
    });
  }

  // Use the artifact builder to compose the prompt body (instructions +
  // demonstrations). This keeps the (eliza_native_v1)-compatible string
  // generation in one place.
  const artifact = buildDspyArtifact({
    task: input.task as DspyArtifactTask,
    baseline: input.baselinePrompt,
    datasetId: input.datasetPath,
    datasetSize: examples.length,
    result,
  });

  return {
    optimizedPrompt: artifact.prompt,
    score: result.score,
    baseline: result.baselineScore,
    lineage: result.lineage,
    fewShotExamples:
      result.demonstrations.length > 0
        ? result.demonstrations.map((demo, idx) => ({
            id: demo.source ?? `demo-${idx}`,
            input: {
              system:
                typeof demo.inputs.system === "string"
                  ? demo.inputs.system
                  : undefined,
              user: String(demo.inputs.input ?? ""),
            },
            expectedOutput: String(demo.outputs.output ?? ""),
            reward: demo.reward,
            metadata: demo.metadata,
          }))
        : undefined,
  };
}

export async function runNativeBackend(
  options: NativeBackendOptions,
): Promise<NativeBackendResult> {
  const dataset = parseJsonlDataset(options.datasetPath);
  const adapter =
    options.adapter ?? createRuntimeAdapter(options.runtime.useModel);
  const scorer = createPromptScorer(adapter, {
    compare: options.task === "action_planner" ? scorePlannerAction : undefined,
  });

  if (dataset.length === 0) {
    return {
      invoked: false,
      optimizer: options.optimizer,
      task: options.task,
      datasetSize: 0,
      score: 0,
      baselineScore: 0,
      result: {
        optimizedPrompt: options.baselinePrompt,
        score: 0,
        baseline: 0,
        lineage: [],
      },
      notes: [
        `dataset at ${options.datasetPath} parsed to 0 usable rows; nothing to optimize`,
      ],
      dataset,
      trainSet: dataset,
      holdoutSet: [],
      scorer,
    };
  }

  const holdoutFraction = options.holdoutFraction ?? DEFAULT_HOLDOUT_FRACTION;
  const { trainSet, holdoutSet } = splitTrainHoldout(dataset, holdoutFraction);

  const result = await dispatchOptimizer(options.optimizer, {
    baselinePrompt: options.baselinePrompt,
    dataset: trainSet,
    scorer,
    llm: adapter,
    task: options.task,
    datasetPath: options.datasetPath,
  });

  const splitNote =
    holdoutSet.length > 0
      ? `split train=${trainSet.length} holdout=${holdoutSet.length} (fraction=${holdoutFraction})`
      : `split disabled (holdoutFraction=${holdoutFraction}, dataset=${dataset.length}); gate will re-use full dataset`;

  return {
    invoked: true,
    optimizer: options.optimizer,
    task: options.task,
    datasetSize: dataset.length,
    score: result.score,
    baselineScore: result.baseline,
    result,
    notes: [
      `optimizer=${options.optimizer} dataset=${basename(options.datasetPath)} size=${dataset.length} baseline=${result.baseline.toFixed(3)} optimized=${result.score.toFixed(3)}`,
      splitNote,
    ],
    dataset,
    trainSet,
    holdoutSet,
    scorer,
  };
}

export const NATIVE_OPTIMIZERS: readonly OptimizerName[] = [
  "instruction-search",
  "prompt-evolution",
  "gepa",
  "bootstrap-fewshot",
  "dspy-bootstrap-fewshot",
  "dspy-copro",
  "dspy-mipro",
] as const;
