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
  createPromptScorer,
  createRuntimeAdapter,
  type LlmAdapter,
  type OptimizationExample,
  type OptimizerName,
  type OptimizerResult,
  type PromptScorer,
  runBootstrapFewshot,
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
}

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
   * Scorer instance used during optimization. Surfaced for the same reason as
   * `dataset` — the promotion gate runs the candidate against the incumbent
   * with the same scoring primitive (Jaccard or planner-action-match,
   * depending on the task).
   */
  scorer: PromptScorer;
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
  },
): Promise<OptimizerResult> {
  switch (optimizer) {
    case "instruction-search":
      return runInstructionSearch(input);
    case "prompt-evolution":
      return runPromptEvolution(input);
    case "bootstrap-fewshot":
      return runBootstrapFewshot(input);
  }
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
      scorer,
    };
  }

  const result = await dispatchOptimizer(options.optimizer, {
    baselinePrompt: options.baselinePrompt,
    dataset,
    scorer,
    llm: adapter,
  });

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
    ],
    dataset,
    scorer,
  };
}

export const NATIVE_OPTIMIZERS: readonly OptimizerName[] = [
  "instruction-search",
  "prompt-evolution",
  "bootstrap-fewshot",
] as const;
