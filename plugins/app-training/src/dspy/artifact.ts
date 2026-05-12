/**
 * Translate a DSPy optimizer result into the eliza_native_v1
 * `OptimizedPromptArtifact` shape consumed by
 * `packages/core/src/services/optimized-prompt.ts`.
 *
 * The on-disk parser is strict (rejects unknown optimizer names), so we tag
 * each artifact with its DSPy optimizer name. We extend the OptimizerName
 * union there in a separate edit (see `optimized-prompt.ts`).
 */

import type { Example } from "./examples.js";
import type { DspyOptimizerResult } from "./optimizers/types.js";
import { renderDemonstrationsBlock } from "./predict.js";

/** Subset of `TrajectoryTrainingTask` plus the new action-descriptions task. */
export type DspyArtifactTask =
  | "should_respond"
  | "context_routing"
  | "action_planner"
  | "response"
  | "media_description"
  | "action_descriptions";

export interface DspyArtifact {
  task: DspyArtifactTask;
  optimizer: "dspy-bootstrap-fewshot" | "dspy-copro" | "dspy-mipro";
  baseline: string;
  prompt: string;
  score: number;
  baselineScore: number;
  datasetId: string;
  datasetSize: number;
  generatedAt: string;
  fewShotExamples?: Array<{
    id?: string;
    input: { system?: string; user: string };
    expectedOutput: string;
    reward?: number;
    metadata?: Record<string, unknown>;
  }>;
  lineage: Array<{
    round: number;
    variant: number;
    score: number;
    notes?: string;
  }>;
  signatureSpec: {
    name: string;
    instructions: string;
    inputs: ReadonlyArray<unknown>;
    outputs: ReadonlyArray<unknown>;
  };
}

export interface BuildArtifactOptions {
  task: DspyArtifactTask;
  baseline: string;
  datasetId: string;
  datasetSize: number;
  result: DspyOptimizerResult;
}

export function buildDspyArtifact(opts: BuildArtifactOptions): DspyArtifact {
  const { result } = opts;
  const sigSpec = result.signature.spec;
  // `prompt` is the fully composed system block: instructions + demonstrations.
  // This is what the runtime substitutes verbatim when it sees the artifact.
  const promptParts = [result.instructions.trim()];
  if (result.demonstrations.length > 0) {
    const demoBlock = renderDemonstrationsBlock(sigSpec, result.demonstrations);
    if (demoBlock) promptParts.push(demoBlock);
  }
  const prompt = promptParts.join("\n\n");

  return {
    task: opts.task,
    optimizer: result.optimizer,
    baseline: opts.baseline,
    prompt,
    score: result.score,
    baselineScore: result.baselineScore,
    datasetId: opts.datasetId,
    datasetSize: opts.datasetSize,
    generatedAt: new Date().toISOString(),
    fewShotExamples:
      result.demonstrations.length > 0
        ? result.demonstrations.map(legacyDemoShape)
        : undefined,
    lineage: result.lineage,
    signatureSpec: {
      name: sigSpec.name,
      instructions: result.instructions,
      inputs: sigSpec.inputs,
      outputs: sigSpec.outputs,
    },
  };
}

function legacyDemoShape(demo: Example): {
  id?: string;
  input: { system?: string; user: string };
  expectedOutput: string;
  reward?: number;
  metadata?: Record<string, unknown>;
} {
  // Collapse our typed input record back into the (system, user) shape the
  // legacy artifact parser expects. We pick the first string-typed input
  // field as the canonical `user` payload.
  let system: string | undefined;
  let user = "";
  for (const [key, value] of Object.entries(demo.inputs)) {
    if (key === "system" && typeof value === "string") {
      system = value;
      continue;
    }
    if (typeof value === "string" && user.length === 0) {
      user = value;
    }
  }
  let expectedOutput = "";
  for (const value of Object.values(demo.outputs)) {
    if (typeof value === "string") {
      expectedOutput = value;
      break;
    }
  }
  return {
    id: demo.source,
    input: { user, system },
    expectedOutput,
    reward: demo.reward,
    metadata: demo.metadata,
  };
}
