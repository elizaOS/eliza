/**
 * Defines and aggregates the deterministic three-attempt report contract for
 * scenario stability runs. Execution remains the caller's responsibility: this
 * module only plans isolated artifact paths and combines completed run reports.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ScenarioReport } from "./types.ts";
import { toRecord } from "./utils.ts";

export const SCENARIO_STABILITY_ATTEMPT_COUNT = 3 as const;
export const SCENARIO_STABILITY_REQUIRED_TIER = "3/3" as const;
export const SCENARIO_STABILITY_MAX_REPORT_BYTES = 64 * 1024 * 1024;
export const SCENARIO_STABILITY_MAX_SCENARIOS = 10_000;
export const SCENARIO_STABILITY_MAX_FAILED_ASSERTIONS = 1_000;
export const SCENARIO_STABILITY_MAX_SCENARIO_ID_LENGTH = 512;
export const SCENARIO_STABILITY_MAX_DETAIL_LENGTH = 64 * 1024;

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
  source: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${source} field '${key}' must be a string`);
  }
  if (
    value.trim().length === 0 ||
    value.length > SCENARIO_STABILITY_MAX_DETAIL_LENGTH
  ) {
    throw new Error(
      `${source} field '${key}' must be 1-${SCENARIO_STABILITY_MAX_DETAIL_LENGTH} characters`,
    );
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

/** Reads one regular JSON artifact without permitting symlinks or unbounded allocation. */
export function readScenarioStabilityJsonArtifact(
  filePath: string,
  source: string,
): unknown {
  const descriptor = openSync(filePath, "r");
  try {
    const fileStat = fstatSync(descriptor);
    const pathStat = lstatSync(filePath);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      !fileStat.isFile() ||
      pathStat.dev !== fileStat.dev ||
      pathStat.ino !== fileStat.ino
    ) {
      throw new Error(
        `${source} must resolve directly to the opened regular file, not a symlink or replaced path`,
      );
    }
    if (fileStat.size > SCENARIO_STABILITY_MAX_REPORT_BYTES) {
      throw new Error(
        `${source} exceeds the ${SCENARIO_STABILITY_MAX_REPORT_BYTES}-byte limit`,
      );
    }

    // The extra byte detects growth after fstat without allocating beyond the
    // declared bound. Shrinkage or replacement becomes invalid JSON or a
    // changed-during-read error rather than a truncated valid artifact.
    const bytes = Buffer.alloc(fileStat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (read === 0) break;
      offset += read;
    }
    if (offset !== fileStat.size) {
      throw new Error(`${source} changed while it was being read`);
    }
    const finalStat = fstatSync(descriptor);
    if (
      finalStat.size !== fileStat.size ||
      finalStat.mtimeMs !== fileStat.mtimeMs ||
      finalStat.ctimeMs !== fileStat.ctimeMs
    ) {
      throw new Error(`${source} changed while it was being read`);
    }
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } finally {
    closeSync(descriptor);
  }
}

/** Reconstructs and verifies a persisted plan against CLI-owned identity and paths. */
export function parseScenarioStabilityPlan(
  value: unknown,
  expected: { runId: string; outputRoot: string },
  source = "scenario stability plan",
): ScenarioStabilityPlan {
  const record = requireRecord(value, source);
  const canonical = createScenarioStabilityPlan(expected);
  if (
    record.schemaVersion !== canonical.schemaVersion ||
    record.runId !== canonical.runId ||
    record.attemptCount !== canonical.attemptCount ||
    record.requiredTier !== canonical.requiredTier ||
    record.outputRoot !== canonical.outputRoot ||
    record.planPath !== canonical.planPath ||
    record.reportPath !== canonical.reportPath ||
    !Array.isArray(record.attempts) ||
    record.attempts.length !== canonical.attempts.length
  ) {
    throw new Error(`${source} does not match the requested run identity`);
  }
  for (const [index, expectedAttempt] of canonical.attempts.entries()) {
    const attempt = requireRecord(
      record.attempts[index],
      `${source} attempt ${index + 1}`,
    );
    if (
      attempt.attemptNumber !== expectedAttempt.attemptNumber ||
      attempt.attemptId !== expectedAttempt.attemptId ||
      attempt.outputDir !== expectedAttempt.outputDir ||
      attempt.reportPath !== expectedAttempt.reportPath
    ) {
      throw new Error(
        `${source} attempt ${index + 1} does not match the requested run identity and isolated paths`,
      );
    }
  }
  return canonical;
}

/** Loads the pre-existing plan that owns attempt identities and artifact paths. */
export function readScenarioStabilityPlan(params: {
  runId: string;
  outputRoot: string;
}): ScenarioStabilityPlan {
  const expected = createScenarioStabilityPlan(params);
  const source = `scenario stability plan '${expected.planPath}'`;
  return parseScenarioStabilityPlan(
    readScenarioStabilityJsonArtifact(expected.planPath, source),
    params,
    source,
  );
}

/** Validates the report subset consumed by stability aggregation. */
export function parseScenarioStabilityAttemptReport(
  value: unknown,
  source = "scenario stability attempt report",
): ScenarioStabilityAttemptReport {
  const report = requireRecord(value, source);
  const runId = report.runId;
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `${source} must contain a 1-128 character filename-safe runId`,
    );
  }
  if (!Array.isArray(report.scenarios)) {
    throw new Error(`${source} must contain a scenarios array`);
  }
  if (report.scenarios.length > SCENARIO_STABILITY_MAX_SCENARIOS) {
    throw new Error(
      `${source} exceeds the ${SCENARIO_STABILITY_MAX_SCENARIOS}-scenario limit`,
    );
  }
  const scenarios = report.scenarios.map((value, index) => {
    const scenarioSource = `${source} scenario ${index + 1}`;
    const scenario = requireRecord(value, scenarioSource);
    if (
      typeof scenario.id !== "string" ||
      scenario.id.trim().length === 0 ||
      scenario.id.length > SCENARIO_STABILITY_MAX_SCENARIO_ID_LENGTH
    ) {
      throw new Error(
        `${scenarioSource} must contain an id of 1-${SCENARIO_STABILITY_MAX_SCENARIO_ID_LENGTH} characters`,
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
    if (
      scenario.failedAssertions.length >
      SCENARIO_STABILITY_MAX_FAILED_ASSERTIONS
    ) {
      throw new Error(
        `${source} scenario '${scenario.id}' exceeds the ${SCENARIO_STABILITY_MAX_FAILED_ASSERTIONS}-assertion limit`,
      );
    }
    const failedAssertions = scenario.failedAssertions.map(
      (assertionValue, assertionIndex) => {
        const assertion = requireRecord(
          assertionValue,
          `${source} scenario '${scenario.id}' assertion ${assertionIndex + 1}`,
        );
        const detail = readOptionalString(
          assertion,
          "detail",
          `${source} scenario '${scenario.id}' assertion ${assertionIndex + 1}`,
        );
        if (!detail) {
          throw new Error(
            `${source} scenario '${scenario.id}' assertion ${assertionIndex + 1} must contain detail`,
          );
        }
        return { detail };
      },
    );
    const skipReason = readOptionalString(
      scenario,
      "skipReason",
      scenarioSource,
    );
    const error = readOptionalString(scenario, "error", scenarioSource);
    if (
      scenario.status === "passed" &&
      (skipReason !== undefined ||
        error !== undefined ||
        failedAssertions.length > 0)
    ) {
      throw new Error(
        `${source} scenario '${scenario.id}' cannot report passed with failure or skip details`,
      );
    }
    if (
      scenario.status === "skipped" &&
      (!skipReason || error !== undefined || failedAssertions.length > 0)
    ) {
      throw new Error(
        `${source} scenario '${scenario.id}' has inconsistent skipped status`,
      );
    }
    if (scenario.status === "failed" && skipReason !== undefined) {
      throw new Error(
        `${source} scenario '${scenario.id}' cannot report failed with a skip reason`,
      );
    }
    return {
      id: scenario.id,
      status: scenario.status,
      skipReason,
      error,
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
  const validatedReports = reports.map((report, index) =>
    parseScenarioStabilityAttemptReport(
      report,
      `scenario stability attempt report ${index + 1}`,
    ),
  );
  const orderedReports = validateAttemptReports(plan, validatedReports);
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
  const canonical = parseScenarioStabilityPlan(
    plan,
    { runId: plan.runId, outputRoot: plan.outputRoot },
    "scenario stability plan",
  );
  if (existsSync(canonical.planPath)) {
    parseScenarioStabilityPlan(
      readScenarioStabilityJsonArtifact(
        canonical.planPath,
        `scenario stability plan '${canonical.planPath}'`,
      ),
      { runId: canonical.runId, outputRoot: canonical.outputRoot },
      `scenario stability plan '${canonical.planPath}'`,
    );
    mkdirSync(canonical.outputRoot, { recursive: true });
    for (const attempt of canonical.attempts) {
      mkdirSync(attempt.outputDir, { recursive: true });
    }
    return;
  }
  mkdirSync(canonical.outputRoot, { recursive: true });
  for (const attempt of canonical.attempts) {
    mkdirSync(attempt.outputDir, { recursive: true });
  }
  writeFileSync(canonical.planPath, `${JSON.stringify(canonical, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
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
  writeFileSync(plan.reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}
