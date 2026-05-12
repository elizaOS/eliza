/**
 * Native prompt-optimization primitives.
 *
 * The optimizers under `plugins/app-training/src/optimizers/` (instruction-search,
 * prompt-evolution, bootstrap-fewshot) all operate on the same triple:
 *
 *   - `OptimizationExample`: a labeled (input -> expected output) row, mirroring
 *     the JSONL shape produced by `trajectory-task-datasets.ts`.
 *   - `PromptScorer`: pluggable evaluator that returns a score in `[0, 1]` for
 *     a candidate prompt against a held-out subset of examples.
 *   - `LlmAdapter`: thin wrapper over `runtime.useModel()` so optimizer code
 *     never depends on a specific provider.
 *
 * Decoupling the LLM behind `LlmAdapter` makes the optimizer modules unit
 * testable with a deterministic in-memory adapter — no HTTP, no fixtures.
 */

import type { TrajectoryTrainingTask } from "../core/trajectory-task-datasets.js";

/**
 * One row in the optimization dataset.
 *
 * `input.system`/`input.user` mirror the `messages` arrays produced by the
 * trajectory dataset exporter (`should_respond`, `response`, etc.). The
 * exporter always wires those into the `system`/`user` slots, so this is the
 * canonical shape for all native optimizer code.
 */
export interface OptimizationExample {
  /** Stable identifier for traceability. Defaults to the row index. */
  id?: string;
  input: {
    system?: string;
    user: string;
  };
  /** Reference output the model should produce. Compared by the scorer. */
  expectedOutput: string;
  /**
   * Optional reward signal recorded with the trajectory (e.g. successful
   * completion = 1). Bootstrap-fewshot uses this to pick top-K demonstrations.
   */
  reward?: number;
  /** Optional per-row metadata (task name, source trajectory id, ...). */
  metadata?: Record<string, unknown>;
}

/**
 * Scorer signature.
 *
 * Returns the mean score in `[0, 1]` across the supplied examples. A scorer
 * MUST be deterministic given the same prompt + dataset + adapter, otherwise
 * the optimizer cannot tell signal from noise across rounds.
 */
export type PromptScorer = (
  prompt: string,
  examples: OptimizationExample[],
) => Promise<number>;

/**
 * Minimal LLM interface the optimizers depend on. Implementations route to
 * `runtime.useModel(ModelType.TEXT_LARGE, …)` in production and to a
 * deterministic stub in tests.
 */
export interface LlmAdapter {
  /**
   * Run a single completion. Returns plain text (no parsing).
   *
   * `temperature` is optional because some adapters (e.g. tests) ignore it,
   * but optimizers should pass it explicitly when they want diverse samples.
   */
  complete(input: {
    system?: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string>;
}

/** Per-round bookkeeping returned by every optimizer. */
export interface OptimizerLineageEntry {
  round: number;
  variant: number;
  score: number;
  notes?: string;
}

/** Common shape returned by all native optimizers. */
export interface OptimizerResult {
  optimizedPrompt: string;
  score: number;
  baseline: number;
  lineage: OptimizerLineageEntry[];
  /** Demonstrations injected into the prompt (bootstrap-fewshot only). */
  fewShotExamples?: OptimizationExample[];
}

export type OptimizerName =
  | "instruction-search"
  | "prompt-evolution"
  | "gepa"
  | "bootstrap-fewshot"
  | "dspy-bootstrap-fewshot"
  | "dspy-copro"
  | "dspy-mipro";

/**
 * Persisted artifact written by the native backend and consumed by
 * `OptimizedPromptService`. The persisted-on-disk schema is checked field by
 * field on read; required fields stay required (no `?? null` fallbacks).
 */
export interface OptimizedPromptArtifact {
  task: TrajectoryTrainingTask;
  optimizer: OptimizerName;
  baseline: string;
  prompt: string;
  score: number;
  baselineScore: number;
  datasetId: string;
  datasetSize: number;
  generatedAt: string;
  fewShotExamples?: OptimizationExample[];
  lineage: OptimizerLineageEntry[];
}
