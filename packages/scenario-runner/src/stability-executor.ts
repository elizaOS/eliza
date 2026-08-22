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
import { validateScenarioStabilityPlan } from "./stability.ts";

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
  planFingerprint: string;
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

export const SCENARIO_STABILITY_MAX_ATTEMPT_JSON_BYTES = 8 * 1024 * 1024;
export const SCENARIO_STABILITY_MAX_EXECUTION_REPORT_BYTES = 64 * 1024 * 1024;
export const SCENARIO_STABILITY_MAX_JSON_DEPTH = 32;
export const SCENARIO_STABILITY_MAX_JSON_NODES = 100_000;
export const SCENARIO_STABILITY_MAX_JSON_WIDTH = 10_000;
export const SCENARIO_STABILITY_MAX_JSON_STRING_BYTES = 256 * 1024;

export function assertScenarioStabilityBoundedJson(
  value: unknown,
  source: string,
  maximumBytes = SCENARIO_STABILITY_MAX_ATTEMPT_JSON_BYTES,
): void {
  const encoder = new TextEncoder();
  const active = new Set<object>();
  const pending: Array<
    { value: unknown; depth: number; path: string } | { exit: object }
  > = [{ value, depth: 0, path: source }];
  let nodes = 0;
  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) break;
    if ("exit" in next) {
      active.delete(next.exit);
      continue;
    }
    nodes += 1;
    if (nodes > SCENARIO_STABILITY_MAX_JSON_NODES) {
      throw new Error(`${source} exceeds the JSON node limit`);
    }
    if (next.depth > SCENARIO_STABILITY_MAX_JSON_DEPTH) {
      throw new Error(`${next.path} exceeds the JSON depth limit`);
    }
    const candidate = next.value;
    if (candidate === null || typeof candidate === "boolean") continue;
    if (typeof candidate === "string") {
      if (
        encoder.encode(candidate).byteLength >
        SCENARIO_STABILITY_MAX_JSON_STRING_BYTES
      ) {
        throw new Error(`${next.path} exceeds the JSON string limit`);
      }
      continue;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
        throw new Error(`${next.path} must be a finite JSON number`);
      }
      continue;
    }
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`${next.path} must contain JSON-only values`);
    }
    if (active.has(candidate)) {
      throw new Error(`${next.path} must not be cyclic`);
    }
    active.add(candidate);
    pending.push({ exit: candidate });
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const ownKeys = Reflect.ownKeys(candidate);
    if (ownKeys.some((key) => typeof key !== "string")) {
      throw new Error(`${next.path} must not contain symbol keys`);
    }
    if (Array.isArray(candidate)) {
      if (Object.getPrototypeOf(candidate) !== Array.prototype) {
        throw new Error(`${next.path} must be an ordinary array`);
      }
      if (candidate.length > SCENARIO_STABILITY_MAX_JSON_WIDTH) {
        throw new Error(`${next.path} exceeds the JSON width limit`);
      }
      const expectedKeys = new Set([
        "length",
        ...Array.from({ length: candidate.length }, (_, index) =>
          String(index),
        ),
      ]);
      if (
        ownKeys.length !== expectedKeys.size ||
        ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
      ) {
        throw new Error(`${next.path} must be a dense ordinary array`);
      }
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) {
          throw new Error(
            `${next.path}[${index}] must be an own data property`,
          );
        }
        pending.push({
          value: descriptor.value,
          depth: next.depth + 1,
          path: `${next.path}[${index}]`,
        });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${next.path} must be an ordinary object`);
    }
    if (ownKeys.length > SCENARIO_STABILITY_MAX_JSON_WIDTH) {
      throw new Error(`${next.path} exceeds the JSON width limit`);
    }
    for (const key of (ownKeys as string[]).reverse()) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) {
        throw new Error(`${next.path}.${key} must be an own data property`);
      }
      if (
        encoder.encode(key).byteLength >
        SCENARIO_STABILITY_MAX_JSON_STRING_BYTES
      ) {
        throw new Error(`${next.path} contains an oversized JSON key`);
      }
      pending.push({
        value: descriptor.value,
        depth: next.depth + 1,
        path: `${next.path}.${key}`,
      });
    }
  }
  const serialized = JSON.stringify(value);
  if (encoder.encode(serialized).byteLength > maximumBytes) {
    throw new Error(
      `${source} exceeds the ${maximumBytes}-byte serialized limit`,
    );
  }
}

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

function validateTarget(target: ScenarioStabilityExecutionTarget): void {
  for (const [name, value] of [
    ["scenarioId", target.scenarioId],
    ["provider", target.model?.provider],
    ["model", target.model?.model],
  ] as const) {
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.length > 512 ||
      value.includes("\0")
    ) {
      throw new Error(`${name} must be a non-empty bounded identifier`);
    }
  }
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
    assertScenarioStabilityBoundedJson(
      execution.evidence[key],
      `attempt evidence.${key}`,
    );
  }
  assertScenarioStabilityBoundedJson(execution.stateDiff, "attempt stateDiff");
  if (
    execution.error !== undefined &&
    (typeof execution.error !== "string" || execution.error.trim().length === 0)
  ) {
    throw new Error("attempt error must be a non-empty string when supplied");
  }
  if (execution.passed && execution.error !== undefined) {
    throw new Error("a passing attempt cannot contain an error");
  }
  if (
    execution.error !== undefined &&
    new TextEncoder().encode(execution.error).byteLength >
      SCENARIO_STABILITY_MAX_JSON_STRING_BYTES
  ) {
    throw new Error("attempt error exceeds the JSON string limit");
  }
  assertScenarioStabilityBoundedJson(execution, "attempt execution");
}

/** Parses an untrusted subprocess result without retaining executable or lossy values. */
export function parseScenarioStabilityAttemptExecution(
  value: unknown,
): ScenarioStabilityAttemptExecution {
  assertScenarioStabilityBoundedJson(value, "attempt execution");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("attempt execution must be an ordinary object");
  }
  const expected = new Set([
    "passed",
    "initialStateHash",
    "finalStateHash",
    "inputTokens",
    "outputTokens",
    "toolCalls",
    "evidence",
    "stateDiff",
    "error",
  ]);
  const keys = Object.keys(value);
  if (
    keys.some((key) => !expected.has(key)) ||
    ![
      "passed",
      "initialStateHash",
      "finalStateHash",
      "inputTokens",
      "outputTokens",
      "toolCalls",
      "evidence",
      "stateDiff",
    ].every((key) => key in value)
  ) {
    throw new Error("attempt execution contains missing or unknown fields");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.passed !== "boolean") {
    throw new Error("attempt passed must be a boolean");
  }
  const execution = record as unknown as ScenarioStabilityAttemptExecution;
  validateExecutionShape(execution);
  return structuredClone(execution);
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

function boundedFailureDetail(error: unknown, fallback: string): string {
  let detail: unknown;
  try {
    if (typeof error === "string") detail = error;
    else if (error && typeof error === "object") {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor && "value" in descriptor) detail = descriptor.value;
    }
  } catch {
    // error-policy:J3 hostile thrown values are reduced to the stable fallback.
    return fallback;
  }
  if (typeof detail !== "string" || detail.trim().length === 0) {
    return fallback;
  }
  const encoded = new TextEncoder().encode(detail);
  if (encoded.byteLength <= SCENARIO_STABILITY_MAX_JSON_STRING_BYTES) {
    return detail;
  }
  let truncated = new TextDecoder().decode(
    encoded.subarray(0, SCENARIO_STABILITY_MAX_JSON_STRING_BYTES),
  );
  while (
    new TextEncoder().encode(truncated).byteLength >
    SCENARIO_STABILITY_MAX_JSON_STRING_BYTES
  ) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
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
  const plan = validateScenarioStabilityPlan(input.plan);
  validateBudgets(input.budgets);
  if (input.targets.length === 0) {
    throw new Error("stability execution requires at least one target");
  }
  if (input.targets.length > 10_000) {
    throw new Error("stability execution target count exceeds 10000");
  }
  const targetKeys = new Set<string>();
  const cells: ScenarioStabilityExecutedCell[] = [];
  for (const target of input.targets) {
    validateTarget(target);
    const key = targetKey(target);
    if (targetKeys.has(key))
      throw new Error(`duplicate stability target ${targetLabel(target)}`);
    targetKeys.add(key);
    const attempts: ScenarioStabilityExecutedAttempt[] = [];
    let baselineInitialStateHash: string | null = null;
    for (const attempt of plan.attempts) {
      const attemptId = `${attempt.attemptId}-${targetSlug(target)}`;
      const outputDir = path.join(attempt.outputDir, targetSlug(target));
      const controller = new AbortController();
      const startedAt = Date.now();
      let execution: ScenarioStabilityAttemptExecution | undefined;
      let failureClassification: ScenarioStabilityFailureClassification | null =
        null;
      try {
        const candidate = await withTimeout(
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
        execution = parseScenarioStabilityAttemptExecution(candidate);
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
          boundedFailureDetail(error, "stability adapter execution failed"),
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
          const teardownError = `attempt teardown failed: ${boundedFailureDetail(error, "stability adapter teardown failed")}`;
          execution = failedExecution(
            execution?.error
              ? boundedFailureDetail(
                  `${execution.error}; ${teardownError}`,
                  "stability adapter execution and teardown failed",
                )
              : boundedFailureDetail(
                  teardownError,
                  "stability adapter teardown failed",
                ),
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
  const report: ScenarioStabilityExecutionReport = {
    schemaVersion: 1,
    runId: plan.runId,
    planFingerprint: createHash("sha256")
      .update(JSON.stringify(plan))
      .digest("hex"),
    status: focusList.length === 0 ? "passed" : "failed",
    attemptCount: 3,
    requiredTier: "3/3",
    budgets: input.budgets,
    cells,
    focusList,
    failureClusters: buildFailureClusters(cells),
  };
  assertScenarioStabilityBoundedJson(
    report,
    "stability execution report",
    SCENARIO_STABILITY_MAX_EXECUTION_REPORT_BYTES,
  );
  return report;
}
