/**
 * Persistence wiring for the A/B promotion gate.
 *
 * Pulled out of `training-orchestrator.ts` so it can be unit-tested without
 * dragging in `@elizaos/agent` (which transitively imports the AI SDK gateway
 * and breaks bare vitest runs). The orchestrator imports and calls
 * `gatedPersistNativeResult` from here.
 *
 * Contract:
 *   1. Resolve the incumbent prompt — current artifact via
 *      `service.getPrompt(task)`, falling back to the baseline template.
 *   2. Run the promotion gate on (incumbent, candidate, dataset, scorer).
 *   3. On promote → write via `service.setPrompt(...)` and prune the per-task
 *      store to the configured retention budget.
 *   4. On reject → write `candidate_rejected_<timestamp>.json` under
 *      `<store-root>/<task>/rejected/` and leave the incumbent in place.
 *
 * No fallbacks on failure: missing services / missing store roots return
 * structured notes so the orchestrator can surface them in the run record.
 */

import type { OptimizationExample, PromptScorer } from "../optimizers/index.js";
import {
  DEFAULT_PROMOTED_ARTIFACT_RETENTION,
  prunePromotedArtifacts,
  writeRejectedCandidate,
} from "./artifact-store.js";
import { evaluatePromotion } from "./promotion-gate.js";
import type { TrajectoryTrainingTask } from "./trajectory-task-datasets.js";

export type PromotionOptimizerName =
  | "instruction-search"
  | "prompt-evolution"
  | "bootstrap-fewshot"
  | "dspy-bootstrap-fewshot"
  | "dspy-copro"
  | "dspy-mipro";

export interface PromotionFewShotExample {
  id?: string;
  input: { user: string; system?: string };
  expectedOutput: string;
  reward?: number;
  metadata?: Record<string, unknown>;
}

export interface PromotionArtifactInput {
  task: TrajectoryTrainingTask;
  optimizer: PromotionOptimizerName;
  baseline: string;
  prompt: string;
  score: number;
  baselineScore: number;
  datasetId: string;
  datasetSize: number;
  generatedAt: string;
  lineage: Array<{
    round: number;
    variant: number;
    score: number;
    notes?: string;
  }>;
  fewShotExamples?: PromotionFewShotExample[];
}

export interface PromotionServiceLike {
  setPrompt: (
    task: TrajectoryTrainingTask,
    artifact: PromotionArtifactInput,
  ) => Promise<string>;
  /**
   * Synchronous accessor for the incumbent prompt. Optional because older
   * builds may not expose it; the gate falls back to the baseline template
   * when missing.
   */
  getPrompt?: (
    task: TrajectoryTrainingTask,
  ) => { prompt: string; optimizerSource: PromotionOptimizerName } | null;
  /**
   * Returns the on-disk root used to store artifacts. Required for rejected /
   * pruned bookkeeping; missing → gate still runs but rejected files are not
   * persisted (logged via notes).
   */
  getStoreRoot?: () => string;
}

export interface PromotionNativeBackendResultLike {
  optimizer: PromotionOptimizerName;
  datasetSize: number;
  score: number;
  baselineScore: number;
  result: {
    optimizedPrompt: string;
    lineage: Array<{
      round: number;
      variant: number;
      score: number;
      notes?: string;
    }>;
    fewShotExamples?: PromotionFewShotExample[];
  };
  dataset: OptimizationExample[];
  scorer: PromptScorer;
}

export interface GatedPersistInput {
  task: TrajectoryTrainingTask;
  datasetPath: string;
  runId: string;
  baselinePrompt: string;
  result: PromotionNativeBackendResultLike;
  service: PromotionServiceLike;
  /** Notes already accumulated by the dispatcher; new lines are appended. */
  notesPrefix: string[];
}

export interface GatedPersistResult {
  invoked: boolean;
  artifactPath?: string;
  notes: string[];
}

/**
 * Gate + persist step extracted from the orchestrator's native dispatcher so
 * it can be tested without spinning up a real optimizer or runtime. Returns
 * the same shape the dispatcher emits.
 */
export async function gatedPersistNativeResult(
  input: GatedPersistInput,
): Promise<GatedPersistResult> {
  const notes = [...input.notesPrefix];

  const incumbentResolved =
    typeof input.service.getPrompt === "function"
      ? input.service.getPrompt(input.task)
      : null;
  const incumbentPrompt = incumbentResolved?.prompt ?? input.baselinePrompt;
  const incumbentSource = incumbentResolved ? "current" : "baseline";

  const decision = await evaluatePromotion({
    incumbentPrompt,
    candidatePrompt: input.result.result.optimizedPrompt,
    dataset: input.result.dataset,
    scorer: input.result.scorer,
  });
  notes.push(
    `promotion-gate ${decision.promote ? "PROMOTE" : "REJECT"} incumbent_source=${incumbentSource} ${decision.reason}`,
  );

  const generatedAt = new Date().toISOString();
  if (!decision.promote) {
    const storeRoot = input.service.getStoreRoot?.();
    if (!storeRoot) {
      notes.push(
        "OptimizedPromptService does not expose getStoreRoot; rejected candidate not persisted",
      );
      return { invoked: true, notes };
    }
    const rejectedPath = await writeRejectedCandidate(storeRoot, input.task, {
      rejectedAt: generatedAt,
      task: input.task,
      optimizer: input.result.optimizer,
      candidatePrompt: input.result.result.optimizedPrompt,
      incumbentPrompt,
      scores: {
        incumbentMeanScore: decision.incumbentMeanScore,
        incumbentStdDev: decision.incumbentStdDev,
        candidateScore: decision.candidateScore,
        delta: decision.delta,
        promotionMargin: decision.promotionMargin,
        noiseThreshold: decision.noiseThreshold,
        incumbentReseeds: decision.incumbentReseeds,
        examplesPerPass: decision.examplesPerPass,
        incumbentScores: decision.incumbentScores,
      },
      reason: decision.reason,
      datasetId: input.datasetPath,
      runId: input.runId,
    });
    notes.push(`rejected candidate written to ${rejectedPath}`);
    return { invoked: true, notes };
  }

  const writePath = await input.service.setPrompt(input.task, {
    task: input.task,
    optimizer: input.result.optimizer,
    baseline: input.baselinePrompt,
    prompt: input.result.result.optimizedPrompt,
    score: input.result.score,
    baselineScore: input.result.baselineScore,
    datasetId: input.datasetPath,
    datasetSize: input.result.datasetSize,
    generatedAt,
    lineage: input.result.result.lineage,
    fewShotExamples: input.result.result.fewShotExamples,
  });
  notes.push(`artifact written to ${writePath}`);

  const storeRoot = input.service.getStoreRoot?.();
  if (storeRoot) {
    const removed = await prunePromotedArtifacts(
      storeRoot,
      input.task,
      DEFAULT_PROMOTED_ARTIFACT_RETENTION,
    );
    if (removed.length > 0) {
      notes.push(
        `pruned ${removed.length} stale artifact(s); retained ${DEFAULT_PROMOTED_ARTIFACT_RETENTION} most recent`,
      );
    }
  }

  return {
    invoked: true,
    artifactPath: writePath,
    notes,
  };
}
