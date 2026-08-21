/**
 * Executes the strict stability matrix against an injected real-runtime
 * boundary. Each scenario/model cell always receives three adapter-isolated
 * attempts, with reset proof and complete evidence capture before the next cell.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  ScenarioStabilityAttemptNumber,
  ScenarioStabilityPlan,
  ScenarioStabilityTier,
} from "./stability.ts";

export interface StabilityModelDimension {
  provider: string;
  model: string;
}

export interface StabilityExecutionTarget {
  scenarioId: string;
  model: StabilityModelDimension;
}

export interface StabilityExecutionBudgets {
  timeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
}

export interface StabilityResetProof {
  schemaVersion: "eliza.synthetic-reset-proof/v1";
  resetId: string;
  generation: number;
  manifestHash: string;
  executionStateHash: string;
  providerStateHash: string;
  modelRegistryHash: string;
}

export interface StabilityAttemptEvidence {
  trajectory: readonly unknown[];
  toolReceipts: readonly unknown[];
  stateTransitions: readonly unknown[];
  providerReceipts: readonly unknown[];
  judgeVerdicts: readonly unknown[];
}

export interface StabilityAttemptExecution {
  passed: boolean;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  evidence: StabilityAttemptEvidence;
  finalExecutionStateHash: string;
  stateDiff: unknown;
  error?: string;
}

export interface StabilityExecutionAdapter {
  reset(input: {
    target: StabilityExecutionTarget;
    attemptNumber: ScenarioStabilityAttemptNumber;
    outputDir: string;
  }): Promise<StabilityResetProof>;
  execute(input: {
    target: StabilityExecutionTarget;
    attemptNumber: ScenarioStabilityAttemptNumber;
    attemptId: string;
    outputDir: string;
    budgets: StabilityExecutionBudgets;
    signal: AbortSignal;
  }): Promise<StabilityAttemptExecution>;
  terminate(input: {
    target: StabilityExecutionTarget;
    attemptNumber: ScenarioStabilityAttemptNumber;
    outputDir: string;
  }): Promise<void>;
}

export interface StabilityExecutedAttempt extends StabilityAttemptExecution {
  attemptNumber: ScenarioStabilityAttemptNumber;
  attemptId: string;
  outputDir: string;
  reset: StabilityResetProof;
  durationMs: number;
  failureClassification: "scenario-failure" | "harness-failure" | null;
}

export interface StabilityExecutedCell {
  scenarioId: string;
  model: StabilityModelDimension;
  passedAttempts: number;
  tier: ScenarioStabilityTier;
  strictPassed: boolean;
  firstAttemptPassed: boolean;
  failureClassifications: readonly ("scenario-failure" | "harness-failure")[];
  baselineResetProof: StabilityResetProof | null;
  attempts: readonly StabilityExecutedAttempt[];
}

export interface StabilityExecutionMatrix {
  schemaVersion: 1;
  runId: string;
  status: "passed" | "failed";
  budgets: StabilityExecutionBudgets;
  initialExecutionStateHash: string;
  cells: readonly StabilityExecutedCell[];
  failureClusters: readonly {
    fingerprint: string;
    classification: "scenario-failure" | "harness-failure";
    occurrences: number;
    cells: readonly string[];
    sample: string;
  }[];
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
}

function validateBudgets(budgets: StabilityExecutionBudgets): void {
  assertPositiveInteger(budgets.timeoutMs, "timeoutMs");
  assertPositiveInteger(budgets.maxInputTokens, "maxInputTokens");
  assertPositiveInteger(budgets.maxOutputTokens, "maxOutputTokens");
  assertPositiveInteger(budgets.maxToolCalls, "maxToolCalls");
}

function tier(passed: number): ScenarioStabilityTier {
  return `${passed}/3` as ScenarioStabilityTier;
}

function targetSlug(target: StabilityExecutionTarget): string {
  const value = `${target.scenarioId}--${target.model.provider}--${target.model.model}`;
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 220)}-${hash}`;
}

function buildFailureClusters(
  cells: readonly StabilityExecutedCell[],
): StabilityExecutionMatrix["failureClusters"] {
  const clusters = new Map<
    string,
    {
      fingerprint: string;
      classification: "scenario-failure" | "harness-failure";
      occurrences: number;
      cells: Set<string>;
      sample: string;
    }
  >();
  for (const cell of cells) {
    const cellId = `${cell.scenarioId}@${cell.model.provider}/${cell.model.model}`;
    for (const attempt of cell.attempts) {
      if (!attempt.failureClassification) continue;
      const sample = (
        attempt.error?.trim() || "attempt failed without an error detail"
      ).slice(0, 4_000);
      const fingerprint = createHash("sha256")
        .update(`${attempt.failureClassification}\0${sample}`)
        .digest("hex");
      const existing = clusters.get(fingerprint);
      if (existing) {
        existing.occurrences += 1;
        existing.cells.add(cellId);
      } else {
        clusters.set(fingerprint, {
          fingerprint,
          classification: attempt.failureClassification,
          occurrences: 1,
          cells: new Set([cellId]),
          sample,
        });
      }
    }
  }
  return [...clusters.values()]
    .map((cluster) => ({ ...cluster, cells: [...cluster.cells].sort() }))
    .sort(
      (a, b) =>
        b.occurrences - a.occurrences ||
        a.fingerprint.localeCompare(b.fingerprint),
    );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(
            new Error(`stability attempt exceeded ${timeoutMs}ms`),
          );
          reject(new Error(`stability attempt exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedJson(value: unknown, label: string): string {
  let json: string;
  try {
    json = JSON.stringify(value, null, 2);
  } catch (error) {
    throw new Error(
      `${label} is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Buffer.byteLength(json) > 64 * 1024 * 1024)
    throw new Error(`${label} exceeds 64 MiB`);
  return `${json}\n`;
}

function validateExecution(
  execution: StabilityAttemptExecution,
  budgets: StabilityExecutionBudgets,
): void {
  for (const [value, name, limit] of [
    [execution.inputTokens, "inputTokens", budgets.maxInputTokens],
    [execution.outputTokens, "outputTokens", budgets.maxOutputTokens],
    [execution.toolCalls, "toolCalls", budgets.maxToolCalls],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > limit)
      throw new Error(`${name} ${value} exceeds its stability budget ${limit}`);
  }
  for (const key of [
    "trajectory",
    "toolReceipts",
    "stateTransitions",
    "providerReceipts",
    "judgeVerdicts",
  ] as const) {
    if (!Array.isArray(execution.evidence[key]))
      throw new Error(`attempt evidence.${key} must be an array`);
  }
}

function validateResetProof(proof: StabilityResetProof): void {
  if (proof.schemaVersion !== "eliza.synthetic-reset-proof/v1")
    throw new Error("reset proof has an unsupported schemaVersion");
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(proof.resetId))
    throw new Error("reset proof has an invalid resetId");
  assertPositiveInteger(proof.generation, "reset generation");
  for (const [name, value] of Object.entries({
    manifestHash: proof.manifestHash,
    executionStateHash: proof.executionStateHash,
    providerStateHash: proof.providerStateHash,
    modelRegistryHash: proof.modelRegistryHash,
  })) {
    if (!/^[a-f0-9]{64}$/.test(value))
      throw new Error(`reset proof ${name} must be a SHA-256 hex digest`);
  }
}

/** Runs every scenario/model cell exactly three times, even after earlier success. */
export async function executeScenarioStabilityMatrix(input: {
  plan: ScenarioStabilityPlan;
  targets: readonly StabilityExecutionTarget[];
  budgets: StabilityExecutionBudgets;
  adapter: StabilityExecutionAdapter;
}): Promise<StabilityExecutionMatrix> {
  validateBudgets(input.budgets);
  if (input.targets.length === 0)
    throw new Error("stability execution requires targets");
  const targetKeys = new Set<string>();
  let initialExecutionStateHash: string | null = null;
  const cells: StabilityExecutedCell[] = [];
  for (const target of input.targets) {
    const key = `${target.scenarioId}\0${target.model.provider}\0${target.model.model}`;
    if (targetKeys.has(key))
      throw new Error(`duplicate stability target ${key}`);
    targetKeys.add(key);
    const attempts: StabilityExecutedAttempt[] = [];
    let cellResetBaseline: StabilityResetProof | null = null;
    for (const attempt of input.plan.attempts) {
      const outputDir = path.join(attempt.outputDir, targetSlug(target));
      mkdirSync(outputDir, { recursive: true });
      let resetError: Error | null = null;
      let reset: StabilityResetProof;
      try {
        reset = await input.adapter.reset({
          target,
          attemptNumber: attempt.attemptNumber,
          outputDir,
        });
        validateResetProof(reset);
      } catch (error) {
        resetError = error instanceof Error ? error : new Error(String(error));
        reset = {
          schemaVersion: "eliza.synthetic-reset-proof/v1",
          resetId: `reset-failed-${attempt.attemptNumber}`,
          generation: attempt.attemptNumber,
          manifestHash: "0".repeat(64),
          executionStateHash: "reset-failed",
          providerStateHash: "reset-failed",
          modelRegistryHash: "reset-failed",
        };
      }
      if (!resetError) {
        cellResetBaseline ??= reset;
        initialExecutionStateHash ??= reset.executionStateHash;
      }
      const startedAt = Date.now();
      const attemptId = `${attempt.attemptId}-${targetSlug(target)}`;
      let execution: StabilityAttemptExecution = {
        passed: false,
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        finalExecutionStateHash: reset.executionStateHash,
        stateDiff: null,
        error: "attempt did not reach execution",
        evidence: {
          trajectory: [],
          toolReceipts: [],
          stateTransitions: [],
          providerReceipts: [],
          judgeVerdicts: [],
        },
      };
      let failureClassification: StabilityExecutedAttempt["failureClassification"] =
        null;
      const controller = new AbortController();
      try {
        if (resetError) throw resetError;
        if (!cellResetBaseline)
          throw new Error("no successful reset proof exists for this cell");
        if (
          reset.executionStateHash !== cellResetBaseline.executionStateHash ||
          reset.providerStateHash !== cellResetBaseline.providerStateHash ||
          reset.modelRegistryHash !== cellResetBaseline.modelRegistryHash ||
          reset.manifestHash !== cellResetBaseline.manifestHash
        )
          throw new Error(
            "reset proof differs from the first attempt in this scenario/model cell",
          );
        const pending = input.adapter.execute({
          target,
          attemptNumber: attempt.attemptNumber,
          attemptId,
          outputDir,
          budgets: input.budgets,
          signal: controller.signal,
        });
        execution = await withTimeout(
          pending,
          input.budgets.timeoutMs,
          controller,
        );
        validateExecution(execution, input.budgets);
        boundedJson(execution.evidence, "attempt evidence");
        failureClassification = execution.passed ? null : "scenario-failure";
      } catch (error) {
        failureClassification = "harness-failure";
        execution = {
          passed: false,
          inputTokens: 0,
          outputTokens: 0,
          toolCalls: 0,
          finalExecutionStateHash: reset.executionStateHash,
          stateDiff: null,
          error: error instanceof Error ? error.message : String(error),
          evidence: {
            trajectory: [],
            toolReceipts: [],
            stateTransitions: [],
            providerReceipts: [],
            judgeVerdicts: [],
          },
        };
      } finally {
        controller.abort();
        try {
          await input.adapter.terminate({
            target,
            attemptNumber: attempt.attemptNumber,
            outputDir,
          });
        } catch (error) {
          failureClassification = "harness-failure";
          execution = {
            ...execution,
            passed: false,
            error: `attempt teardown failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      const result: StabilityExecutedAttempt = {
        ...execution,
        attemptNumber: attempt.attemptNumber,
        attemptId,
        outputDir,
        reset,
        durationMs: Date.now() - startedAt,
        failureClassification,
      };
      attempts.push(result);
      writeFileSync(
        path.join(outputDir, "attempt-evidence.json"),
        boundedJson(result, "attempt result"),
        { encoding: "utf8", flag: "wx" },
      );
    }
    const passedAttempts = attempts.filter((attempt) => attempt.passed).length;
    cells.push({
      scenarioId: target.scenarioId,
      model: target.model,
      passedAttempts,
      tier: tier(passedAttempts),
      strictPassed: passedAttempts === 3,
      firstAttemptPassed: attempts[0]?.passed === true,
      failureClassifications: [
        ...new Set(
          attempts.flatMap((item) =>
            item.failureClassification ? [item.failureClassification] : [],
          ),
        ),
      ].sort(),
      baselineResetProof: cellResetBaseline,
      attempts,
    });
  }
  const matrix: StabilityExecutionMatrix = {
    schemaVersion: 1,
    runId: input.plan.runId,
    status: cells.every((cell) => cell.strictPassed) ? "passed" : "failed",
    budgets: input.budgets,
    initialExecutionStateHash: initialExecutionStateHash ?? "unavailable",
    cells,
    failureClusters: buildFailureClusters(cells),
  };
  writeFileSync(
    path.join(input.plan.outputRoot, "stability-execution.json"),
    boundedJson(matrix, "stability execution matrix"),
    { encoding: "utf8", flag: "wx" },
  );
  return matrix;
}
