/**
 * Executes strict three-attempt scenario/model cells through an injected
 * runtime boundary. The boundary owns runtime construction and teardown while
 * this module owns unconditional attempts, budgets, isolation comparison, and
 * deterministic stability reporting.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import type {
  ScenarioStabilityAttemptNumber,
  ScenarioStabilityFailureClassification,
  ScenarioStabilityPlan,
  ScenarioStabilityTier,
} from "./stability.ts";

export interface ScenarioStabilityModel {
  provider: string;
  model: string;
}

export interface ScenarioStabilityExecutionTarget {
  scenarioId: string;
  model: ScenarioStabilityModel;
}

export interface ScenarioStabilityExecutionBudgets {
  timeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
}

export interface ScenarioStabilityExecutionEvidence {
  trajectory: readonly unknown[];
  toolReceipts: readonly unknown[];
  stateTransitions: readonly unknown[];
  providerReceipts: readonly unknown[];
  judgeVerdicts: readonly unknown[];
}

export interface ScenarioStabilityAttemptExecution {
  passed: boolean;
  initialStateHash: string;
  finalStateHash: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  evidence: ScenarioStabilityExecutionEvidence;
  stateDiff: unknown;
  error?: string;
}

export interface ScenarioStabilityExecutionAdapter {
  execute(input: {
    target: ScenarioStabilityExecutionTarget;
    attemptNumber: ScenarioStabilityAttemptNumber;
    attemptId: string;
    outputDir: string;
    budgets: ScenarioStabilityExecutionBudgets;
    signal: AbortSignal;
  }): Promise<ScenarioStabilityAttemptExecution>;
  terminate(input: {
    target: ScenarioStabilityExecutionTarget;
    attemptNumber: ScenarioStabilityAttemptNumber;
    attemptId: string;
    outputDir: string;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface ScenarioStabilityExecutedAttempt
  extends ScenarioStabilityAttemptExecution {
  attemptNumber: ScenarioStabilityAttemptNumber;
  attemptId: string;
  outputDir: string;
  durationMs: number;
  failureClassification: ScenarioStabilityFailureClassification | null;
}

export interface ScenarioStabilityExecutedCell {
  scenarioId: string;
  model: ScenarioStabilityModel;
  baselineInitialStateHash: string | null;
  firstAttemptPassed: boolean;
  passedAttempts: number;
  tier: ScenarioStabilityTier;
  strictPassed: boolean;
  attempts: readonly ScenarioStabilityExecutedAttempt[];
}

export interface ScenarioStabilityExecutionReport {
  schemaVersion: 1;
  runId: string;
  status: "passed" | "failed";
  attemptCount: 3;
  requiredTier: "3/3";
  budgets: ScenarioStabilityExecutionBudgets;
  cells: readonly ScenarioStabilityExecutedCell[];
  focusList: readonly {
    scenarioId: string;
    provider: string;
    model: string;
    tier: ScenarioStabilityTier;
    firstAttemptPassed: boolean;
    failedAttemptIds: readonly string[];
    failureClassifications: readonly ScenarioStabilityFailureClassification[];
  }[];
  failureClusters: readonly {
    fingerprint: string;
    classification: ScenarioStabilityFailureClassification;
    occurrences: number;
    cells: readonly string[];
    sample: string;
  }[];
}

const EMPTY_EVIDENCE: ScenarioStabilityExecutionEvidence = {
  trajectory: [],
  toolReceipts: [],
  stateTransitions: [],
  providerReceipts: [],
  judgeVerdicts: [],
};

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function validateBudgets(budgets: ScenarioStabilityExecutionBudgets): void {
  assertPositiveSafeInteger(budgets.timeoutMs, "timeoutMs");
  assertPositiveSafeInteger(budgets.maxInputTokens, "maxInputTokens");
  assertPositiveSafeInteger(budgets.maxOutputTokens, "maxOutputTokens");
  if (!Number.isSafeInteger(budgets.maxToolCalls) || budgets.maxToolCalls < 0) {
    throw new Error("maxToolCalls must be a non-negative safe integer");
  }
}

function targetKey(target: ScenarioStabilityExecutionTarget): string {
  return `${target.scenarioId}\0${target.model.provider}\0${target.model.model}`;
}

function targetLabel(target: ScenarioStabilityExecutionTarget): string {
  return `${target.scenarioId}@${target.model.provider}/${target.model.model}`;
}

function targetSlug(target: ScenarioStabilityExecutionTarget): string {
  const key = targetKey(target);
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
  const readable = key.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 180);
  return `${readable}-${digest}`;
}

function tier(passedAttempts: number): ScenarioStabilityTier {
  if (passedAttempts < 0 || passedAttempts > 3) {
    throw new Error(`invalid scenario stability pass count ${passedAttempts}`);
  }
  return `${passedAttempts}/3` as ScenarioStabilityTier;
}

function validateExecutionShape(
  execution: ScenarioStabilityAttemptExecution,
): void {
  for (const [name, value] of Object.entries({
    initialStateHash: execution.initialStateHash,
    finalStateHash: execution.finalStateHash,
  })) {
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.length > 512
    ) {
      throw new Error(
        `${name} must be a non-empty string of at most 512 characters`,
      );
    }
  }
  for (const [name, value] of Object.entries({
    inputTokens: execution.inputTokens,
    outputTokens: execution.outputTokens,
    toolCalls: execution.toolCalls,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`);
    }
  }
  for (const key of [
    "trajectory",
    "toolReceipts",
    "stateTransitions",
    "providerReceipts",
    "judgeVerdicts",
  ] as const) {
    if (!Array.isArray(execution.evidence?.[key])) {
      throw new Error(`attempt evidence.${key} must be an array`);
    }
  }
  if (execution.error !== undefined && execution.error.trim().length === 0) {
    throw new Error("attempt error must be a non-empty string when supplied");
  }
  if (execution.passed && execution.error !== undefined) {
    throw new Error("a passing attempt cannot contain an error");
  }
}

function budgetViolation(
  execution: ScenarioStabilityAttemptExecution,
  budgets: ScenarioStabilityExecutionBudgets,
): string | null {
  for (const [name, value, limit] of [
    ["inputTokens", execution.inputTokens, budgets.maxInputTokens],
    ["outputTokens", execution.outputTokens, budgets.maxOutputTokens],
    ["toolCalls", execution.toolCalls, budgets.maxToolCalls],
  ] as const) {
    if (value > limit)
      return `${name} ${value} exceeds its stability budget ${limit}`;
  }
  return null;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  phase = "attempt",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`stability ${phase} exceeded ${timeoutMs}ms`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function failedExecution(
  error: string,
  execution?: ScenarioStabilityAttemptExecution,
): ScenarioStabilityAttemptExecution {
  return execution
    ? { ...execution, passed: false, error }
    : {
        passed: false,
        initialStateHash: "unavailable",
        finalStateHash: "unavailable",
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        evidence: EMPTY_EVIDENCE,
        stateDiff: null,
        error,
      };
}

function normalizedFailureSample(
  attempt: ScenarioStabilityExecutedAttempt,
): string {
  return (attempt.error?.trim() || "attempt failed without an error detail")
    .replaceAll(attempt.outputDir, "<attempt-output>")
    .replaceAll(attempt.attemptId, "<attempt-id>")
    .slice(0, 4_000);
}

function buildFailureClusters(
  cells: readonly ScenarioStabilityExecutedCell[],
): ScenarioStabilityExecutionReport["failureClusters"] {
  const clusters = new Map<
    string,
    {
      fingerprint: string;
      classification: ScenarioStabilityFailureClassification;
      occurrences: number;
      cells: Set<string>;
      sample: string;
    }
  >();
  for (const cell of cells) {
    for (const attempt of cell.attempts) {
      if (!attempt.failureClassification) continue;
      const sample = normalizedFailureSample(attempt);
      const fingerprint = createHash("sha256")
        .update(`${attempt.failureClassification}\0${sample}`)
        .digest("hex");
      const existing = clusters.get(fingerprint);
      if (existing) {
        existing.occurrences += 1;
        existing.cells.add(targetLabel(cell));
      } else {
        clusters.set(fingerprint, {
          fingerprint,
          classification: attempt.failureClassification,
          occurrences: 1,
          cells: new Set([targetLabel(cell)]),
          sample,
        });
      }
    }
  }
  return [...clusters.values()]
    .map((cluster) => ({ ...cluster, cells: [...cluster.cells].sort() }))
    .sort(
      (left, right) =>
        right.occurrences - left.occurrences ||
        left.fingerprint.localeCompare(right.fingerprint),
    );
}

/** Runs every declared scenario/provider/model cell exactly three times. */
export async function executeScenarioStability(input: {
  plan: ScenarioStabilityPlan;
  targets: readonly ScenarioStabilityExecutionTarget[];
  budgets: ScenarioStabilityExecutionBudgets;
  adapter: ScenarioStabilityExecutionAdapter;
}): Promise<ScenarioStabilityExecutionReport> {
  validateBudgets(input.budgets);
  if (input.targets.length === 0) {
    throw new Error("stability execution requires at least one target");
  }
  const targetKeys = new Set<string>();
  const cells: ScenarioStabilityExecutedCell[] = [];
  for (const target of input.targets) {
    const key = targetKey(target);
    if (targetKeys.has(key))
      throw new Error(`duplicate stability target ${targetLabel(target)}`);
    targetKeys.add(key);
    const attempts: ScenarioStabilityExecutedAttempt[] = [];
    let baselineInitialStateHash: string | null = null;
    for (const attempt of input.plan.attempts) {
      const attemptId = `${attempt.attemptId}-${targetSlug(target)}`;
      const outputDir = path.join(attempt.outputDir, targetSlug(target));
      const controller = new AbortController();
      const startedAt = Date.now();
      let execution: ScenarioStabilityAttemptExecution | undefined;
      let failureClassification: ScenarioStabilityFailureClassification | null =
        null;
      try {
        execution = await withTimeout(
          input.adapter.execute({
            target,
            attemptNumber: attempt.attemptNumber,
            attemptId,
            outputDir,
            budgets: input.budgets,
            signal: controller.signal,
          }),
          input.budgets.timeoutMs,
          controller,
        );
        validateExecutionShape(execution);
        baselineInitialStateHash ??= execution.initialStateHash;
        const violation = budgetViolation(execution, input.budgets);
        if (execution.initialStateHash !== baselineInitialStateHash) {
          failureClassification = "harness-failure";
          execution = failedExecution(
            `initial state hash differs from the first attempt in this cell: ${execution.initialStateHash}`,
            execution,
          );
        } else if (violation) {
          failureClassification = "scenario-failure";
          execution = failedExecution(violation, execution);
        } else if (!execution.passed) {
          failureClassification = "scenario-failure";
        } else {
          failureClassification = null;
        }
      } catch (error) {
        failureClassification = "harness-failure";
        execution = failedExecution(
          error instanceof Error ? error.message : String(error),
          execution,
        );
      } finally {
        controller.abort();
        const teardownController = new AbortController();
        try {
          await withTimeout(
            input.adapter.terminate({
              target,
              attemptNumber: attempt.attemptNumber,
              attemptId,
              outputDir,
              signal: teardownController.signal,
            }),
            input.budgets.timeoutMs,
            teardownController,
            "attempt teardown",
          );
        } catch (error) {
          failureClassification = "harness-failure";
          const teardownError = `attempt teardown failed: ${error instanceof Error ? error.message : String(error)}`;
          execution = failedExecution(
            execution?.error
              ? `${execution.error}; ${teardownError}`
              : teardownError,
            execution,
          );
        } finally {
          teardownController.abort();
        }
      }
      const result = execution ?? failedExecution("attempt produced no result");
      attempts.push({
        ...result,
        attemptNumber: attempt.attemptNumber,
        attemptId,
        outputDir,
        durationMs: Date.now() - startedAt,
        failureClassification,
      });
    }
    const passedAttempts = attempts.filter((attempt) => attempt.passed).length;
    cells.push({
      scenarioId: target.scenarioId,
      model: target.model,
      baselineInitialStateHash,
      firstAttemptPassed: attempts[0]?.passed === true,
      passedAttempts,
      tier: tier(passedAttempts),
      strictPassed: passedAttempts === 3,
      attempts,
    });
  }
  const focusList = cells
    .filter((cell) => !cell.strictPassed)
    .map((cell) => ({
      scenarioId: cell.scenarioId,
      provider: cell.model.provider,
      model: cell.model.model,
      tier: cell.tier,
      firstAttemptPassed: cell.firstAttemptPassed,
      failedAttemptIds: cell.attempts
        .filter((attempt) => !attempt.passed)
        .map((attempt) => attempt.attemptId),
      failureClassifications: [
        ...new Set(
          cell.attempts.flatMap((attempt) =>
            attempt.failureClassification
              ? [attempt.failureClassification]
              : [],
          ),
        ),
      ].sort(),
    }));
  return {
    schemaVersion: 1,
    runId: input.plan.runId,
    status: focusList.length === 0 ? "passed" : "failed",
    attemptCount: 3,
    requiredTier: "3/3",
    budgets: input.budgets,
    cells,
    focusList,
    failureClusters: buildFailureClusters(cells),
  };
}
