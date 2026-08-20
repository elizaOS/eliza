/**
 * Defines and aggregates the deterministic three-attempt report contract for
 * scenario stability runs. Execution remains the caller's responsibility: this
 * module only plans isolated artifact paths and combines completed run reports.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ScenarioReport } from "./types.ts";
import { toRecord } from "./utils.ts";

export const SCENARIO_STABILITY_ATTEMPT_COUNT = 3 as const;
export const SCENARIO_STABILITY_REQUIRED_TIER = "3/3" as const;

export type ScenarioStabilityAttemptNumber = 1 | 2 | 3;
export type ScenarioStabilityTier = "3/3" | "2/3" | "1/3" | "0/3";
export type ScenarioStabilityFailureClassification =
  | "scenario-failure"
  | "harness-failure";

export interface ScenarioStabilityAttemptPlan {
  attemptNumber: ScenarioStabilityAttemptNumber;
  attemptId: string;
  outputDir: string;
  reportPath: string;
}

export interface ScenarioStabilityPlan {
  schemaVersion: 1;
  runId: string;
  attemptCount: typeof SCENARIO_STABILITY_ATTEMPT_COUNT;
  requiredTier: typeof SCENARIO_STABILITY_REQUIRED_TIER;
  outputRoot: string;
  planPath: string;
  reportPath: string;
  attempts: readonly [
    ScenarioStabilityAttemptPlan,
    ScenarioStabilityAttemptPlan,
    ScenarioStabilityAttemptPlan,
  ];
}

export interface ScenarioStabilityAttemptScenarioReport {
  id: string;
  status: ScenarioReport["status"];
  skipReason?: string;
  error?: string;
  failedAssertions: readonly { detail?: string }[];
}

export interface ScenarioStabilityAttemptReport {
  runId: string;
  scenarios: readonly ScenarioStabilityAttemptScenarioReport[];
}

export interface ScenarioStabilityAttemptResult {
  attemptNumber: ScenarioStabilityAttemptNumber;
  attemptId: string;
  status: ScenarioReport["status"] | "missing";
  passed: boolean;
  failureClassification: ScenarioStabilityFailureClassification | null;
  detail: string | null;
}

export interface ScenarioStabilityScenarioResult {
  scenarioId: string;
  firstAttemptPassed: boolean;
  passedAttempts: number;
  tier: ScenarioStabilityTier;
  strictPassed: boolean;
  attempts: readonly ScenarioStabilityAttemptResult[];
}

export interface ScenarioStabilityFocusItem {
  scenarioId: string;
  tier: ScenarioStabilityTier;
  failedAttemptIds: readonly string[];
  failureClassifications: readonly ScenarioStabilityFailureClassification[];
}

export interface ScenarioStabilityReport {
  schemaVersion: 1;
  runId: string;
  status: "passed" | "failed";
  attemptCount: typeof SCENARIO_STABILITY_ATTEMPT_COUNT;
  requiredTier: typeof SCENARIO_STABILITY_REQUIRED_TIER;
  attempts: ScenarioStabilityPlan["attempts"];
  scenarios: readonly ScenarioStabilityScenarioResult[];
  focusList: readonly ScenarioStabilityFocusItem[];
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function createAttemptPlan(
  runId: string,
  outputRoot: string,
  attemptNumber: ScenarioStabilityAttemptNumber,
): ScenarioStabilityAttemptPlan {
  const label = `attempt-${String(attemptNumber).padStart(2, "0")}`;
  const outputDir = path.join(outputRoot, label);
  return {
    attemptNumber,
    attemptId: `${runId}-${label}`,
    outputDir,
    reportPath: path.join(outputDir, "matrix.json"),
  };
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      "scenario stability runId must be 1-128 filename-safe characters and start with an alphanumeric character",
    );
  }
}

/** Creates the immutable IDs and pairwise-isolated directories for three attempts. */
export function createScenarioStabilityPlan(params: {
  runId: string;
  outputRoot: string;
}): ScenarioStabilityPlan {
  assertRunId(params.runId);
  const outputRoot = path.resolve(params.outputRoot);
  const attempts: ScenarioStabilityPlan["attempts"] = [
    createAttemptPlan(params.runId, outputRoot, 1),
    createAttemptPlan(params.runId, outputRoot, 2),
    createAttemptPlan(params.runId, outputRoot, 3),
  ];

  return {
    schemaVersion: 1,
    runId: params.runId,
    attemptCount: SCENARIO_STABILITY_ATTEMPT_COUNT,
    requiredTier: SCENARIO_STABILITY_REQUIRED_TIER,
    outputRoot,
    planPath: path.join(outputRoot, "stability-plan.json"),
    reportPath: path.join(outputRoot, "stability.json"),
    attempts,
  };
}

function readOptionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`scenario stability field '${key}' must be a string`);
  }
  return value;
}

function requireRecord(
  value: unknown,
  source: string,
): Readonly<Record<string, unknown>> {
  const record = toRecord(value);
  if (!record) throw new Error(`${source} must be an object`);
  return record;
}

/** Validates the report subset consumed by stability aggregation. */
export function parseScenarioStabilityAttemptReport(
  value: unknown,
  source = "scenario stability attempt report",
): ScenarioStabilityAttemptReport {
  const report = requireRecord(value, source);
  const runId = report.runId;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error(`${source} must contain a non-empty string runId`);
  }
  if (!Array.isArray(report.scenarios)) {
    throw new Error(`${source} must contain a scenarios array`);
  }
  const scenarios = report.scenarios.map((value, index) => {
    const scenario = requireRecord(value, `${source} scenario ${index + 1}`);
    if (typeof scenario.id !== "string" || scenario.id.length === 0) {
      throw new Error(
        `${source} scenario ${index + 1} must contain a non-empty id`,
      );
    }
    if (
      scenario.status !== "passed" &&
      scenario.status !== "failed" &&
      scenario.status !== "skipped"
    ) {
      throw new Error(
        `${source} scenario '${scenario.id}' has invalid status '${String(scenario.status)}'`,
      );
    }
    if (!Array.isArray(scenario.failedAssertions)) {
      throw new Error(
        `${source} scenario '${scenario.id}' must contain a failedAssertions array`,
      );
    }
    const failedAssertions = scenario.failedAssertions.map(
      (assertionValue, assertionIndex) => {
        const assertion = requireRecord(
          assertionValue,
          `${source} scenario '${scenario.id}' assertion ${assertionIndex + 1}`,
        );
        return { detail: readOptionalString(assertion, "detail") };
      },
    );
    return {
      id: scenario.id,
      status: scenario.status,
      skipReason: readOptionalString(scenario, "skipReason"),
      error: readOptionalString(scenario, "error"),
      failedAssertions,
    } satisfies ScenarioStabilityAttemptScenarioReport;
  });
  return { runId, scenarios };
}

function scenariosById(
  report: ScenarioStabilityAttemptReport,
): Map<string, ScenarioStabilityAttemptScenarioReport> {
  const scenarios = new Map<string, ScenarioStabilityAttemptScenarioReport>();
  for (const scenario of report.scenarios) {
    if (scenarios.has(scenario.id)) {
      throw new Error(
        `scenario stability attempt ${report.runId} contains duplicate scenario id '${scenario.id}'`,
      );
    }
    scenarios.set(scenario.id, scenario);
  }
  return scenarios;
}

function classifyAttempt(
  plan: ScenarioStabilityAttemptPlan,
  scenario: ScenarioStabilityAttemptScenarioReport | undefined,
): ScenarioStabilityAttemptResult {
  if (!scenario) {
    return {
      attemptNumber: plan.attemptNumber,
      attemptId: plan.attemptId,
      status: "missing",
      passed: false,
      failureClassification: "harness-failure",
      detail: "scenario report missing from attempt",
    };
  }
  if (scenario.status === "passed") {
    return {
      attemptNumber: plan.attemptNumber,
      attemptId: plan.attemptId,
      status: "passed",
      passed: true,
      failureClassification: null,
      detail: null,
    };
  }
  if (scenario.status === "skipped") {
    return {
      attemptNumber: plan.attemptNumber,
      attemptId: plan.attemptId,
      status: "skipped",
      passed: false,
      failureClassification: "harness-failure",
      detail: scenario.skipReason ?? "scenario skipped without a reason",
    };
  }
  return {
    attemptNumber: plan.attemptNumber,
    attemptId: plan.attemptId,
    status: "failed",
    passed: false,
    failureClassification: "scenario-failure",
    detail:
      scenario.error ??
      scenario.failedAssertions[0]?.detail ??
      "scenario failed without a reported assertion",
  };
}

function stabilityTier(passedAttempts: number): ScenarioStabilityTier {
  switch (passedAttempts) {
    case 0:
      return "0/3";
    case 1:
      return "1/3";
    case 2:
      return "2/3";
    case 3:
      return "3/3";
    default:
      throw new Error(
        `invalid scenario stability pass count ${passedAttempts}`,
      );
  }
}

function validateAttemptReports(
  plan: ScenarioStabilityPlan,
  reports: readonly ScenarioStabilityAttemptReport[],
): readonly ScenarioStabilityAttemptReport[] {
  if (reports.length !== SCENARIO_STABILITY_ATTEMPT_COUNT) {
    throw new Error(
      `scenario stability requires exactly ${SCENARIO_STABILITY_ATTEMPT_COUNT} attempt reports; received ${reports.length}`,
    );
  }
  const reportsByRunId = new Map<string, ScenarioStabilityAttemptReport>();
  for (const report of reports) {
    if (reportsByRunId.has(report.runId)) {
      throw new Error(
        `duplicate scenario stability attempt runId '${report.runId}'`,
      );
    }
    reportsByRunId.set(report.runId, report);
  }
  const ordered = plan.attempts.map((attempt) => {
    const report = reportsByRunId.get(attempt.attemptId);
    if (!report) {
      throw new Error(
        `scenario stability attempt report '${attempt.attemptId}' is missing or has the wrong runId`,
      );
    }
    return report;
  });
  if (reportsByRunId.size !== plan.attempts.length) {
    throw new Error("scenario stability received an unexpected attempt runId");
  }
  return ordered;
}

/** Aggregates exactly three completed attempt matrices under a strict 3/3 policy. */
export function buildScenarioStabilityReport(
  plan: ScenarioStabilityPlan,
  reports: readonly ScenarioStabilityAttemptReport[],
): ScenarioStabilityReport {
  const orderedReports = validateAttemptReports(plan, reports);
  const attemptsByScenario = orderedReports.map(scenariosById);
  const scenarioIds = [
    ...new Set(
      attemptsByScenario.flatMap((scenarios) => [...scenarios.keys()]),
    ),
  ].sort();
  if (scenarioIds.length === 0) {
    throw new Error(
      "scenario stability cannot aggregate three empty attempt reports",
    );
  }

  const scenarios = scenarioIds.map((scenarioId) => {
    const attempts = plan.attempts.map((attempt, index) =>
      classifyAttempt(attempt, attemptsByScenario[index]?.get(scenarioId)),
    );
    const passedAttempts = attempts.filter((attempt) => attempt.passed).length;
    const tier = stabilityTier(passedAttempts);
    return {
      scenarioId,
      firstAttemptPassed: attempts[0]?.passed === true,
      passedAttempts,
      tier,
      strictPassed: tier === SCENARIO_STABILITY_REQUIRED_TIER,
      attempts,
    } satisfies ScenarioStabilityScenarioResult;
  });
  const focusList = scenarios
    .filter((scenario) => !scenario.strictPassed)
    .map((scenario) => ({
      scenarioId: scenario.scenarioId,
      tier: scenario.tier,
      failedAttemptIds: scenario.attempts
        .filter((attempt) => !attempt.passed)
        .map((attempt) => attempt.attemptId),
      failureClassifications: [
        ...new Set(
          scenario.attempts.flatMap((attempt) =>
            attempt.failureClassification
              ? [attempt.failureClassification]
              : [],
          ),
        ),
      ].sort(),
    }));

  return {
    schemaVersion: 1,
    runId: plan.runId,
    status: focusList.length === 0 ? "passed" : "failed",
    attemptCount: SCENARIO_STABILITY_ATTEMPT_COUNT,
    requiredTier: SCENARIO_STABILITY_REQUIRED_TIER,
    attempts: plan.attempts,
    scenarios,
    focusList,
  };
}

/** Writes the plan so external execution can consume exact attempt IDs and paths. */
export function writeScenarioStabilityPlan(plan: ScenarioStabilityPlan): void {
  mkdirSync(plan.outputRoot, { recursive: true });
  for (const attempt of plan.attempts) {
    mkdirSync(attempt.outputDir, { recursive: true });
  }
  writeFileSync(plan.planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

/** Writes the deterministic aggregate at the path declared by its plan. */
export function writeScenarioStabilityReport(
  plan: ScenarioStabilityPlan,
  report: ScenarioStabilityReport,
): void {
  if (plan.runId !== report.runId) {
    throw new Error(
      `scenario stability report runId '${report.runId}' does not match plan '${plan.runId}'`,
    );
  }
  mkdirSync(plan.outputRoot, { recursive: true });
  writeFileSync(
    plan.reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}
