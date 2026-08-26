/**
 * Owns the manifest-driven Cloud stability lane contract and report artifacts.
 * The controller is dependency-injected so unit tests exercise plan, failure,
 * and artifact semantics without substituting for the production subprocess adapter.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, mkdir, open, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  assertScenarioStabilityBoundedJson,
  assertScenarioStabilityExecutedCellCoherence,
  createScenarioStabilityPlan,
  deriveScenarioStabilityExecutionAttemptIdentities,
  deriveScenarioStabilityFailureClusters,
  deriveScenarioStabilityFocusList,
  executeScenarioStability,
  parseScenarioStabilityAttemptExecution,
  type ScenarioStabilityExecutionAdapter,
  type ScenarioStabilityExecutionBudgets,
  type ScenarioStabilityExecutionReport,
  type ScenarioStabilityExecutionTarget,
  type ScenarioStabilityFailureClassification,
  type ScenarioStabilityTier,
  scenarioStabilityExecutionPlanFingerprint,
} from "@elizaos/scenario-runner";
import { canonicalJsonString } from "@elizaos/shared/canonical-json";

export type CloudStabilityMode = "deterministic-mock" | "real-llm";

export interface CloudStabilityManifest {
  schemaVersion: 1;
  runId: string;
  mode: CloudStabilityMode;
  scenarioId: string;
  provider: string;
  model: string;
  scenarioFingerprint: string;
  worldFingerprint: string;
  fixtureManifestFingerprint?: string;
  timeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
}

const CLOUD_STABILITY_MAX_CANONICAL_BYTES = 8 * 1024 * 1024;
const CLOUD_STABILITY_CHECKSUM_BYTES = 81;

const CLOUD_STABILITY_CANONICAL_OPTIONS = {
  maxDepth: 32,
  maxNodes: 100_000,
  maxOutputChars: CLOUD_STABILITY_MAX_CANONICAL_BYTES,
  sparseArrayHoles: "null" as const,
  onUnbounded: () => {
    throw new Error("Cloud stability artifact exceeds canonical limits");
  },
};

function boundedIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9._/-]+$/.test(value)
  ) {
    throw new Error(`${field} must be a bounded identifier`);
  }
  return value;
}

function stabilityRunId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new Error("runId must match the canonical stability plan pattern");
  }
  return value;
}

/** Returns the one bounded byte representation used for storage and hashing. */
export function canonicalCloudStabilityJson(value: unknown): string {
  const canonical = canonicalJsonString(
    value,
    CLOUD_STABILITY_CANONICAL_OPTIONS,
  );
  if (
    Buffer.byteLength(canonical, "utf8") > CLOUD_STABILITY_MAX_CANONICAL_BYTES
  ) {
    throw new Error("Cloud stability artifact exceeds canonical byte limit");
  }
  return canonical;
}

export function canonicalCloudStabilitySha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalCloudStabilityJson(value), "utf8")
    .digest("hex");
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

/** Validates the checked-in or workflow-supplied lane manifest. */
export function parseCloudStabilityManifest(
  value: unknown,
): CloudStabilityManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cloud stability manifest must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Cloud stability manifest must be an ordinary object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !descriptors[key] ||
        !("value" in descriptors[key]),
    )
  ) {
    throw new Error("Cloud stability manifest requires own data properties");
  }
  const record = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
  const expectedKeys = new Set([
    "schemaVersion",
    "runId",
    "mode",
    "scenarioId",
    "provider",
    "model",
    "scenarioFingerprint",
    "worldFingerprint",
    "timeoutMs",
    "maxInputTokens",
    "maxOutputTokens",
    "maxToolCalls",
    ...(record.mode === "deterministic-mock"
      ? ["fixtureManifestFingerprint"]
      : []),
  ]);
  if (
    Object.keys(record).length !== expectedKeys.size ||
    Object.keys(record).some((key) => !expectedKeys.has(key))
  ) {
    throw new Error("Cloud stability manifest contains noncanonical fields");
  }
  if (record.schemaVersion !== 1) {
    throw new Error("Cloud stability manifest schemaVersion must be 1");
  }
  if (record.mode !== "deterministic-mock" && record.mode !== "real-llm") {
    throw new Error("Cloud stability manifest mode is invalid");
  }
  const parsed: CloudStabilityManifest = {
    schemaVersion: 1,
    runId: stabilityRunId(record.runId),
    mode: record.mode,
    scenarioId: boundedIdentifier(record.scenarioId, "scenarioId"),
    provider: boundedIdentifier(record.provider, "provider"),
    model: boundedIdentifier(record.model, "model"),
    scenarioFingerprint: boundedIdentifier(
      record.scenarioFingerprint,
      "scenarioFingerprint",
    ),
    worldFingerprint: boundedIdentifier(
      record.worldFingerprint,
      "worldFingerprint",
    ),
    timeoutMs: positiveInteger(record.timeoutMs, "timeoutMs"),
    maxInputTokens: positiveInteger(record.maxInputTokens, "maxInputTokens"),
    maxOutputTokens: positiveInteger(record.maxOutputTokens, "maxOutputTokens"),
    maxToolCalls: positiveInteger(record.maxToolCalls, "maxToolCalls"),
  };
  if (record.mode === "deterministic-mock") {
    if (
      typeof record.fixtureManifestFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.fixtureManifestFingerprint)
    ) {
      throw new Error(
        "deterministic mode requires a SHA-256 fixture fingerprint",
      );
    }
    parsed.fixtureManifestFingerprint = record.fixtureManifestFingerprint;
  }
  return parsed;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusiveFile(
  filePath: string,
  bytes: string,
): Promise<void> {
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  let complete = false;
  const failures: unknown[] = [];
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    complete = true;
  } catch (error) {
    // error-policy:J2 Artifact creation preserves the exact write failure.
    failures.push(error);
  }
  try {
    await handle.close();
  } catch (error) {
    // error-policy:J2 Artifact creation preserves close durability failures.
    failures.push(error);
  }
  if (!complete) {
    try {
      await unlink(filePath);
    } catch (error) {
      // error-policy:J6 A missing failed artifact needs no cleanup.
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) {
    throw new Error("Cloud stability exclusive artifact write failed", {
      cause: failures[0],
    });
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Cloud stability exclusive artifact write failed",
    );
  }
}

export interface RunCloudStabilityLaneInput {
  manifest: CloudStabilityManifest;
  outputRoot: string;
  adapter: ScenarioStabilityExecutionAdapter;
}

export interface CloudStabilityArtifactManifest extends CloudStabilityManifest {
  manifestSha256: string;
  reportSha256: string;
}

export interface VerifiedCloudStabilityArtifacts {
  report: ScenarioStabilityExecutionReport;
  manifest: CloudStabilityArtifactManifest;
  reportSha256: string;
}

async function readBoundedArtifact(
  filePath: string,
  maximumBytes: number,
): Promise<Buffer> {
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximumBytes)) {
      throw new Error(`${path.basename(filePath)} exceeds its artifact limit`);
    }
    const expectedBytes = Number(before.size);
    const bytes = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const result = await handle.read(
        bytes,
        offset,
        expectedBytes - offset,
        offset,
      );
      if (result.bytesRead === 0) {
        throw new Error(`${path.basename(filePath)} changed while being read`);
      }
      offset += result.bytesRead;
    }
    const eofProbe = Buffer.allocUnsafe(1);
    const probe = await handle.read(eofProbe, 0, 1, expectedBytes);
    const after = await handle.stat({ bigint: true });
    if (
      probe.bytesRead !== 0 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(`${path.basename(filePath)} changed while being read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseCanonicalArtifact(bytes: Buffer, artifactName: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    // error-policy:J2 Invalid retained JSON is an integrity failure with cause.
    throw new Error(`${artifactName} is not valid JSON`, { cause });
  }
  const canonical = Buffer.from(canonicalCloudStabilityJson(parsed), "utf8");
  if (!bytes.equals(canonical)) {
    throw new Error(`${artifactName} is not canonical JSON`);
  }
  return parsed;
}

function strictRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an ordinary object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be an ordinary object`);
  }
  const record = Object.fromEntries(Object.entries(value));
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
  return record;
}

function strictArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function boundedString(
  value: unknown,
  label: string,
  maximumLength = 512,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function sha256String(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function stabilityTier(value: unknown, label: string): ScenarioStabilityTier {
  if (
    value !== "0/3" &&
    value !== "1/3" &&
    value !== "2/3" &&
    value !== "3/3"
  ) {
    throw new Error(`${label} is not a stability tier`);
  }
  return value;
}

function failureClassification(
  value: unknown,
  label: string,
): ScenarioStabilityFailureClassification {
  if (value !== "scenario-failure" && value !== "harness-failure") {
    throw new Error(`${label} is not a failure classification`);
  }
  return value;
}

function parseExecutionBudgets(
  value: unknown,
): ScenarioStabilityExecutionBudgets {
  const record = strictRecord(value, "stability report budgets", [
    "timeoutMs",
    "maxInputTokens",
    "maxOutputTokens",
    "maxToolCalls",
  ]);
  return {
    timeoutMs: positiveInteger(record.timeoutMs, "report timeoutMs"),
    maxInputTokens: positiveInteger(
      record.maxInputTokens,
      "report maxInputTokens",
    ),
    maxOutputTokens: positiveInteger(
      record.maxOutputTokens,
      "report maxOutputTokens",
    ),
    maxToolCalls: nonNegativeInteger(
      record.maxToolCalls,
      "report maxToolCalls",
    ),
  };
}

function canonicalAttemptNumber(index: number, value: unknown): 1 | 2 | 3 {
  let expected: 1 | 2 | 3;
  if (index === 0) expected = 1;
  else if (index === 1) expected = 2;
  else if (index === 2) expected = 3;
  else throw new Error("stability report contains more than three attempts");
  if (value !== expected) {
    throw new Error(
      `stability report attempt ${index + 1} has a noncanonical attempt number`,
    );
  }
  return expected;
}

function parseExecutedAttempt(value: unknown, index: number) {
  const label = `stability report attempt ${index + 1}`;
  const record = strictRecord(
    value,
    label,
    [
      "passed",
      "initialStateHash",
      "finalStateHash",
      "inputTokens",
      "outputTokens",
      "toolCalls",
      "evidence",
      "stateDiff",
      "attemptNumber",
      "attemptId",
      "outputDir",
      "durationMs",
      "failureClassification",
    ],
    ["error"],
  );
  const base = {
    passed: record.passed,
    initialStateHash: record.initialStateHash,
    finalStateHash: record.finalStateHash,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    toolCalls: record.toolCalls,
    evidence: record.evidence,
    stateDiff: record.stateDiff,
  };
  const execution = parseScenarioStabilityAttemptExecution(
    Object.hasOwn(record, "error") ? { ...base, error: record.error } : base,
  );
  const attemptNumber = canonicalAttemptNumber(index, record.attemptNumber);
  const classification =
    record.failureClassification === null
      ? null
      : failureClassification(
          record.failureClassification,
          `${label} failureClassification`,
        );
  return {
    ...execution,
    attemptNumber,
    attemptId: boundedString(record.attemptId, `${label} attemptId`),
    outputDir: boundedString(record.outputDir, `${label} outputDir`, 4_096),
    durationMs: nonNegativeInteger(record.durationMs, `${label} durationMs`),
    failureClassification: classification,
  };
}

function parseExecutedCell(value: unknown, index: number) {
  const label = `stability report cell ${index + 1}`;
  const record = strictRecord(value, label, [
    "scenarioId",
    "model",
    "baselineInitialStateHash",
    "firstAttemptPassed",
    "passedAttempts",
    "tier",
    "strictPassed",
    "attempts",
  ]);
  const model = strictRecord(record.model, `${label} model`, [
    "provider",
    "model",
  ]);
  const attempts = strictArray(record.attempts, `${label} attempts`).map(
    parseExecutedAttempt,
  );
  if (attempts.length !== 3) {
    throw new Error(`${label} must contain exactly three attempts`);
  }
  const passedAttempts = nonNegativeInteger(
    record.passedAttempts,
    `${label} passedAttempts`,
  );
  const tier = stabilityTier(record.tier, `${label} tier`);
  const strictPassed = booleanValue(
    record.strictPassed,
    `${label} strictPassed`,
  );
  const firstAttemptPassed = booleanValue(
    record.firstAttemptPassed,
    `${label} firstAttemptPassed`,
  );
  const baselineInitialStateHash =
    record.baselineInitialStateHash === null
      ? null
      : boundedString(
          record.baselineInitialStateHash,
          `${label} baselineInitialStateHash`,
        );
  return {
    scenarioId: boundedString(record.scenarioId, `${label} scenarioId`),
    model: {
      provider: boundedString(model.provider, `${label} provider`),
      model: boundedString(model.model, `${label} model name`),
    },
    baselineInitialStateHash,
    firstAttemptPassed,
    passedAttempts,
    tier,
    strictPassed,
    attempts,
  };
}

function parseFocusItem(value: unknown, index: number) {
  const label = `stability report focus item ${index + 1}`;
  const record = strictRecord(value, label, [
    "scenarioId",
    "provider",
    "model",
    "tier",
    "firstAttemptPassed",
    "failedAttemptIds",
    "failureClassifications",
  ]);
  return {
    scenarioId: boundedString(record.scenarioId, `${label} scenarioId`),
    provider: boundedString(record.provider, `${label} provider`),
    model: boundedString(record.model, `${label} model`),
    tier: stabilityTier(record.tier, `${label} tier`),
    firstAttemptPassed: booleanValue(
      record.firstAttemptPassed,
      `${label} firstAttemptPassed`,
    ),
    failedAttemptIds: strictArray(
      record.failedAttemptIds,
      `${label} failedAttemptIds`,
    ).map((attemptId) => boundedString(attemptId, `${label} attemptId`)),
    failureClassifications: strictArray(
      record.failureClassifications,
      `${label} failureClassifications`,
    ).map((classification) =>
      failureClassification(classification, `${label} classification`),
    ),
  };
}

function parseFailureCluster(value: unknown, index: number) {
  const label = `stability report failure cluster ${index + 1}`;
  const record = strictRecord(value, label, [
    "fingerprint",
    "classification",
    "occurrences",
    "cells",
    "sample",
  ]);
  return {
    fingerprint: sha256String(record.fingerprint, `${label} fingerprint`),
    classification: failureClassification(
      record.classification,
      `${label} classification`,
    ),
    occurrences: positiveInteger(record.occurrences, `${label} occurrences`),
    cells: strictArray(record.cells, `${label} cells`).map((cell) =>
      boundedString(cell, `${label} cell`, 1_536),
    ),
    sample: boundedString(record.sample, `${label} sample`, 4_000),
  };
}

function parseCloudStabilityExecutionReport(
  value: unknown,
  manifest: CloudStabilityManifest,
  planOutputRoot: string,
): ScenarioStabilityExecutionReport {
  assertScenarioStabilityBoundedJson(
    value,
    "Cloud stability aggregate report",
    CLOUD_STABILITY_MAX_CANONICAL_BYTES,
  );
  const record = strictRecord(value, "Cloud stability aggregate report", [
    "schemaVersion",
    "runId",
    "planFingerprint",
    "status",
    "attemptCount",
    "requiredTier",
    "budgets",
    "cells",
    "focusList",
    "failureClusters",
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.attemptCount !== 3 ||
    record.requiredTier !== "3/3" ||
    (record.status !== "passed" && record.status !== "failed")
  ) {
    throw new Error("Cloud stability aggregate report constants are invalid");
  }
  const runId = stabilityRunId(record.runId);
  const planFingerprint = sha256String(
    record.planFingerprint,
    "stability report planFingerprint",
  );
  const budgets = parseExecutionBudgets(record.budgets);
  const cells = strictArray(record.cells, "stability report cells").map(
    parseExecutedCell,
  );
  for (const cell of cells) {
    assertScenarioStabilityExecutedCellCoherence(cell);
  }
  const focusList = strictArray(
    record.focusList,
    "stability report focusList",
  ).map(parseFocusItem);
  const failureClusters = strictArray(
    record.failureClusters,
    "stability report failureClusters",
  ).map(parseFailureCluster);
  if (cells.length !== 1) {
    throw new Error("Cloud stability aggregate must contain exactly one cell");
  }
  const cell = cells[0];
  const target: ScenarioStabilityExecutionTarget = {
    scenarioId: manifest.scenarioId,
    model: { provider: manifest.provider, model: manifest.model },
  };
  const plan = createScenarioStabilityPlan({
    runId: manifest.runId,
    outputRoot: planOutputRoot,
  });
  const expectedAttemptIdentities =
    deriveScenarioStabilityExecutionAttemptIdentities(plan, target);
  if (
    !cell ||
    runId !== manifest.runId ||
    cell.scenarioId !== manifest.scenarioId ||
    cell.model.provider !== manifest.provider ||
    cell.model.model !== manifest.model ||
    budgets.timeoutMs !== manifest.timeoutMs ||
    budgets.maxInputTokens !== manifest.maxInputTokens ||
    budgets.maxOutputTokens !== manifest.maxOutputTokens ||
    budgets.maxToolCalls !== manifest.maxToolCalls ||
    planFingerprint !== scenarioStabilityExecutionPlanFingerprint(plan) ||
    cell.attempts.some((attempt, index) => {
      const expected = expectedAttemptIdentities[index];
      return (
        !expected ||
        attempt.attemptNumber !== expected.attemptNumber ||
        attempt.attemptId !== expected.attemptId ||
        attempt.outputDir !== expected.outputDir
      );
    })
  ) {
    throw new Error("Cloud stability aggregate does not match its manifest");
  }
  const expectedFocusList = deriveScenarioStabilityFocusList(cells);
  const expectedFailureClusters = deriveScenarioStabilityFailureClusters(cells);
  if (
    canonicalCloudStabilityJson(focusList) !==
      canonicalCloudStabilityJson(expectedFocusList) ||
    canonicalCloudStabilityJson(failureClusters) !==
      canonicalCloudStabilityJson(expectedFailureClusters) ||
    record.status !== (expectedFocusList.length === 0 ? "passed" : "failed")
  ) {
    throw new Error(
      "Cloud stability aggregate summaries do not match derived execution evidence",
    );
  }
  return {
    schemaVersion: 1,
    runId,
    planFingerprint,
    status: record.status,
    attemptCount: 3,
    requiredTier: "3/3",
    budgets,
    cells,
    focusList,
    failureClusters,
  };
}

function parseArtifactManifest(value: unknown): CloudStabilityArtifactManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cloud stability artifact manifest must be an object");
  }
  const record = Object.fromEntries(Object.entries(value));
  const { manifestSha256, ...unsignedArtifactManifest } = record;
  const { reportSha256, ...laneManifest } = unsignedArtifactManifest;
  if (
    typeof manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    typeof reportSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(reportSha256)
  ) {
    throw new Error("Cloud stability artifact manifest hashes are invalid");
  }
  const manifest = parseCloudStabilityManifest(laneManifest);
  if (
    manifestSha256 !==
    canonicalCloudStabilitySha256({ ...manifest, reportSha256 })
  ) {
    throw new Error("Cloud stability manifest checksum does not match");
  }
  return { ...manifest, manifestSha256, reportSha256 };
}

async function verifyCloudStabilityArtifactsAt(
  outputRoot: string,
  planOutputRoot: string,
): Promise<VerifiedCloudStabilityArtifacts> {
  const [reportBytes, checksumBytes, manifestBytes] = await Promise.all([
    readBoundedArtifact(
      path.join(outputRoot, "stability.json"),
      CLOUD_STABILITY_MAX_CANONICAL_BYTES,
    ),
    readBoundedArtifact(
      path.join(outputRoot, "stability.sha256"),
      CLOUD_STABILITY_CHECKSUM_BYTES,
    ),
    readBoundedArtifact(
      path.join(outputRoot, "manifest.json"),
      CLOUD_STABILITY_MAX_CANONICAL_BYTES,
    ),
  ]);
  const manifest = parseArtifactManifest(
    parseCanonicalArtifact(manifestBytes, "manifest.json"),
  );
  const reportValue = parseCanonicalArtifact(reportBytes, "stability.json");
  const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
  const expectedSidecar = `${reportSha256}  stability.json\n`;
  if (!checksumBytes.equals(Buffer.from(expectedSidecar, "utf8"))) {
    throw new Error("stability.sha256 does not match retained report bytes");
  }
  if (
    manifest.reportSha256 !== reportSha256 ||
    canonicalCloudStabilitySha256(reportValue) !== reportSha256
  ) {
    throw new Error("Cloud stability report checksums do not match");
  }
  const report = parseCloudStabilityExecutionReport(
    reportValue,
    manifest,
    planOutputRoot,
  );
  return { report, manifest, reportSha256 };
}

/** Verifies retained report bytes, sidecar, manifest, and output-path authority. */
export async function verifyCloudStabilityArtifacts(
  outputRoot: string,
): Promise<VerifiedCloudStabilityArtifacts> {
  return verifyCloudStabilityArtifactsAt(outputRoot, outputRoot);
}

async function removeStagedBundle(stagingRoot: string): Promise<void> {
  for (const name of ["stability.json", "stability.sha256", "manifest.json"]) {
    try {
      await unlink(path.join(stagingRoot, name));
    } catch (error) {
      // error-policy:J6 A missing staged file is expected after partial setup.
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  await rmdir(stagingRoot);
}

async function persistCloudStabilityArtifacts(
  outputRoot: string,
  report: ScenarioStabilityExecutionReport,
  manifest: CloudStabilityManifest,
): Promise<void> {
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const reportBytes = canonicalCloudStabilityJson(report);
  const reportSha256 = createHash("sha256")
    .update(reportBytes, "utf8")
    .digest("hex");
  if (reportSha256 !== canonicalCloudStabilitySha256(report)) {
    throw new Error("Cloud stability report bytes are not canonical");
  }
  const unsignedArtifactManifest = {
    ...manifest,
    reportSha256,
  };
  const artifactManifest = {
    ...unsignedArtifactManifest,
    manifestSha256: canonicalCloudStabilitySha256(unsignedArtifactManifest),
  };
  const stagingRoot = path.join(
    outputRoot,
    `.stability-stage-${randomBytes(16).toString("hex")}`,
  );
  await mkdir(stagingRoot, { mode: 0o700 });
  await syncDirectory(outputRoot);

  const promoted: string[] = [];
  try {
    await writeExclusiveFile(
      path.join(stagingRoot, "stability.json"),
      reportBytes,
    );
    await writeExclusiveFile(
      path.join(stagingRoot, "stability.sha256"),
      `${reportSha256}  stability.json\n`,
    );
    await writeExclusiveFile(
      path.join(stagingRoot, "manifest.json"),
      canonicalCloudStabilityJson(artifactManifest),
    );
    await syncDirectory(stagingRoot);
    await verifyCloudStabilityArtifactsAt(stagingRoot, outputRoot);

    // The manifest is the commit marker: it is linked last, and no link may
    // replace a prior artifact generation. Readers either verify all three or
    // fail closed while promotion is in progress.
    for (const name of [
      "stability.json",
      "stability.sha256",
      "manifest.json",
    ]) {
      await link(path.join(stagingRoot, name), path.join(outputRoot, name));
      promoted.push(name);
    }
    await syncDirectory(outputRoot);
    await verifyCloudStabilityArtifacts(outputRoot);
    await removeStagedBundle(stagingRoot);
    await syncDirectory(outputRoot);
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    for (const name of promoted.reverse()) {
      try {
        await unlink(path.join(outputRoot, name));
      } catch (cleanupError) {
        // error-policy:J6 Promotion rollback is best-effort but never hidden.
        cleanupFailures.push(cleanupError);
      }
    }
    try {
      await syncDirectory(outputRoot);
    } catch (cleanupError) {
      // error-policy:J6 Promotion rollback durability failure is reported.
      cleanupFailures.push(cleanupError);
    }
    try {
      await removeStagedBundle(stagingRoot);
    } catch (cleanupError) {
      // error-policy:J6 Staging cleanup failure is reported with the cause.
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Cloud stability artifact promotion and cleanup failed",
      );
    }
    throw error;
  }
}

/** Executes and persists the exact-three aggregate even when it blocks the lane. */
export async function runCloudStabilityLane(
  input: RunCloudStabilityLaneInput,
): Promise<ScenarioStabilityExecutionReport> {
  const manifest = parseCloudStabilityManifest(input.manifest);
  const target: ScenarioStabilityExecutionTarget = {
    scenarioId: manifest.scenarioId,
    model: { provider: manifest.provider, model: manifest.model },
  };
  const report = await executeScenarioStability({
    plan: createScenarioStabilityPlan({
      runId: manifest.runId,
      outputRoot: input.outputRoot,
    }),
    targets: [target],
    budgets: {
      timeoutMs: manifest.timeoutMs,
      maxInputTokens: manifest.maxInputTokens,
      maxOutputTokens: manifest.maxOutputTokens,
      maxToolCalls: manifest.maxToolCalls,
    },
    adapter: input.adapter,
  });
  await persistCloudStabilityArtifacts(input.outputRoot, report, manifest);
  return report;
}
