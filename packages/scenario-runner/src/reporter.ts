/**
 * JSON + stdout reporting for the scenario runner. The JSON shape is what
 * `scripts/run-scenario-benchmark.mjs` expects back (scenarios[], totalCount,
 * failedCount) plus the richer per-scenario fields we emit for humans.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";
import {
  isScenarioEvidenceScope,
  isScenarioExecutionProfile,
  type ScenarioEvidenceScope,
  type ScenarioExecutionProfile,
  scenarioEvidenceScopeLabel,
} from "@elizaos/scenario-runner/schema";
import type {
  AggregateReport,
  ScenarioEvidenceObservationKind,
  ScenarioReport,
} from "./types.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OBSERVER_KINDS = new Set([
  "provider-api",
  "provider-webhook",
  "durable-database",
  "scheduler-runner",
]);
const APPROVAL_STATES = new Set([
  "pending",
  "approved",
  "executing",
  "done",
  "rejected",
  "expired",
]);
const DRAFT_STATES = new Set(["draft", "queued", "approved", "discarded"]);
const SCHEDULED_TASK_STATES = new Set([
  "persisted",
  "claimed",
  "executing",
  "completed",
  "failed",
  "canceled",
]);

function evidenceFailure(
  scenarioId: string,
  path: string,
  detail: string,
): never {
  throw new Error(
    `scenario "${scenarioId}" has invalid evidence at ${path}: ${detail}`,
  );
}

function requireEvidenceRecord(
  scenarioId: string,
  path: string,
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    evidenceFailure(scenarioId, path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function requireEvidenceString(
  scenarioId: string,
  path: string,
  value: unknown,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    evidenceFailure(scenarioId, path, "expected a non-empty string");
  }
  return value;
}

function requireSha256(
  scenarioId: string,
  path: string,
  value: unknown,
): string {
  const hash = requireEvidenceString(scenarioId, path, value);
  if (!SHA256_PATTERN.test(hash)) {
    evidenceFailure(
      scenarioId,
      path,
      "expected exactly 64 lowercase hexadecimal characters",
    );
  }
  return hash;
}

function requireIsoTimestamp(
  scenarioId: string,
  path: string,
  value: unknown,
): string {
  const timestamp = requireEvidenceString(scenarioId, path, value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      timestamp,
    ) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    evidenceFailure(scenarioId, path, "expected an ISO-8601 timestamp");
  }
  return timestamp;
}

function requireEvidenceArray(
  scenarioId: string,
  path: string,
  value: unknown,
): unknown[] {
  if (!Array.isArray(value)) {
    evidenceFailure(scenarioId, path, "expected an array");
  }
  return value;
}

function requireStringList(
  scenarioId: string,
  path: string,
  value: unknown,
  minimumLength: number,
): string[] {
  const values = requireEvidenceArray(scenarioId, path, value);
  if (values.length < minimumLength) {
    evidenceFailure(
      scenarioId,
      path,
      `expected at least ${minimumLength} item(s)`,
    );
  }
  return values.map((item, index) =>
    requireEvidenceString(scenarioId, `${path}[${index}]`, item),
  );
}

function validateTrajectoryHashes(
  scenarioId: string,
  value: unknown,
): Map<string, string> {
  const hashes = requireEvidenceArray(
    scenarioId,
    "evidence.trajectoryHashes",
    value,
  );
  const trajectoryHashes = new Map<string, string>();
  hashes.forEach((item, index) => {
    const path = `evidence.trajectoryHashes[${index}]`;
    const hash = requireEvidenceRecord(scenarioId, path, item);
    const trajectoryId = requireEvidenceString(
      scenarioId,
      `${path}.trajectoryId`,
      hash.trajectoryId,
    );
    if (trajectoryHashes.has(trajectoryId)) {
      evidenceFailure(
        scenarioId,
        `${path}.trajectoryId`,
        `duplicate trajectoryId "${trajectoryId}"`,
      );
    }
    requireEvidenceString(
      scenarioId,
      `${path}.relativePath`,
      hash.relativePath,
    );
    const sha256 = requireSha256(scenarioId, `${path}.sha256`, hash.sha256);
    const recorder = requireEvidenceRecord(
      scenarioId,
      `${path}.recorder`,
      hash.recorder,
    );
    requireEvidenceString(
      scenarioId,
      `${path}.recorder.implementation`,
      recorder.implementation,
    );
    requireEvidenceString(
      scenarioId,
      `${path}.recorder.version`,
      recorder.version,
    );
    requireEvidenceString(
      scenarioId,
      `${path}.recorder.environment`,
      recorder.environment,
    );
    trajectoryHashes.set(trajectoryId, sha256);
  });
  return trajectoryHashes;
}

function validateObserverProvenance(
  scenarioId: string,
  value: unknown,
): Map<string, string> {
  const observers = requireEvidenceArray(
    scenarioId,
    "evidence.observerProvenance",
    value,
  );
  const observerKinds = new Map<string, string>();
  observers.forEach((item, index) => {
    const path = `evidence.observerProvenance[${index}]`;
    const observer = requireEvidenceRecord(scenarioId, path, item);
    const observerId = requireEvidenceString(
      scenarioId,
      `${path}.observerId`,
      observer.observerId,
    );
    if (observerKinds.has(observerId)) {
      evidenceFailure(
        scenarioId,
        `${path}.observerId`,
        `duplicate observerId "${observerId}"`,
      );
    }
    const kind = requireEvidenceString(
      scenarioId,
      `${path}.kind`,
      observer.kind,
    );
    if (!OBSERVER_KINDS.has(kind)) {
      evidenceFailure(
        scenarioId,
        `${path}.kind`,
        `unsupported trusted observer kind "${kind}"`,
      );
    }
    requireEvidenceString(
      scenarioId,
      `${path}.implementation`,
      observer.implementation,
    );
    requireEvidenceString(scenarioId, `${path}.version`, observer.version);
    requireEvidenceString(
      scenarioId,
      `${path}.environment`,
      observer.environment,
    );
    requireSha256(
      scenarioId,
      `${path}.configurationSha256`,
      observer.configurationSha256,
    );
    observerKinds.set(observerId, kind);
  });
  return observerKinds;
}

function validateObservationSource(
  scenarioId: string,
  path: string,
  value: unknown,
  allowedKinds: readonly string[],
): string {
  const source = requireEvidenceRecord(scenarioId, path, value);
  const kind = requireEvidenceString(scenarioId, `${path}.kind`, source.kind);
  if (!allowedKinds.includes(kind)) {
    evidenceFailure(
      scenarioId,
      `${path}.kind`,
      `expected one of ${allowedKinds.join(", ")}; action-result/model-prose sources are not trusted evidence`,
    );
  }
  requireEvidenceString(scenarioId, `${path}.system`, source.system);
  requireEvidenceString(scenarioId, `${path}.environment`, source.environment);
  requireSha256(scenarioId, `${path}.recordIdSha256`, source.recordIdSha256);
  if (source.accountRefSha256 !== undefined) {
    requireSha256(
      scenarioId,
      `${path}.accountRefSha256`,
      source.accountRefSha256,
    );
  }
  return kind;
}

function validateTrajectoryReferences(
  scenarioId: string,
  path: string,
  value: unknown,
  trajectoryHashes: ReadonlyMap<string, string>,
): void {
  const references = requireEvidenceArray(scenarioId, path, value);
  if (references.length === 0) {
    evidenceFailure(
      scenarioId,
      path,
      "every trusted observation must reference at least one trajectory stage",
    );
  }
  references.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const reference = requireEvidenceRecord(scenarioId, itemPath, item);
    const trajectoryId = requireEvidenceString(
      scenarioId,
      `${itemPath}.trajectoryId`,
      reference.trajectoryId,
    );
    requireEvidenceString(scenarioId, `${itemPath}.stageId`, reference.stageId);
    const sha256 = requireSha256(
      scenarioId,
      `${itemPath}.sha256`,
      reference.sha256,
    );
    const expectedHash = trajectoryHashes.get(trajectoryId);
    if (!expectedHash) {
      evidenceFailure(
        scenarioId,
        `${itemPath}.trajectoryId`,
        `references unreported trajectory "${trajectoryId}"`,
      );
    }
    if (sha256 !== expectedHash) {
      evidenceFailure(
        scenarioId,
        `${itemPath}.sha256`,
        `does not match evidence.trajectoryHashes for "${trajectoryId}"`,
      );
    }
  });
}

function validateObservationHashFields(
  scenarioId: string,
  path: string,
  observation: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (observation[field] !== undefined) {
      requireSha256(scenarioId, `${path}.${field}`, observation[field]);
    }
  }
}

function validateEvidenceObservations(
  scenarioId: string,
  value: unknown,
  observerKinds: ReadonlyMap<string, string>,
  trajectoryHashes: ReadonlyMap<string, string>,
): ScenarioEvidenceObservationKind[] {
  const observations = requireEvidenceArray(
    scenarioId,
    "evidence.observations",
    value,
  );
  const observationIds = new Set<string>();
  return observations.map((item, index) => {
    const path = `evidence.observations[${index}]`;
    const observation = requireEvidenceRecord(scenarioId, path, item);
    const observationId = requireEvidenceString(
      scenarioId,
      `${path}.observationId`,
      observation.observationId,
    );
    if (observationIds.has(observationId)) {
      evidenceFailure(
        scenarioId,
        `${path}.observationId`,
        `duplicate observationId "${observationId}"`,
      );
    }
    observationIds.add(observationId);
    requireIsoTimestamp(
      scenarioId,
      `${path}.observedAtIso`,
      observation.observedAtIso,
    );
    const observerId = requireEvidenceString(
      scenarioId,
      `${path}.observerId`,
      observation.observerId,
    );
    const kind = requireEvidenceString(
      scenarioId,
      `${path}.kind`,
      observation.kind,
    );
    const allowedSourceKinds =
      kind === "durable-approval" || kind === "durable-draft"
        ? ["durable-database"]
        : kind === "provider-effect"
          ? ["provider-api", "provider-webhook"]
          : kind === "provider-no-effect"
            ? ["provider-api"]
            : kind === "scheduled-task"
              ? ["durable-database", "scheduler-runner"]
              : null;
    if (!allowedSourceKinds) {
      evidenceFailure(
        scenarioId,
        `${path}.kind`,
        `unsupported observation kind "${kind}"; action results and model prose cannot qualify`,
      );
    }
    const sourceKind = validateObservationSource(
      scenarioId,
      `${path}.source`,
      observation.source,
      allowedSourceKinds,
    );
    const observerKind = observerKinds.get(observerId);
    if (!observerKind) {
      evidenceFailure(
        scenarioId,
        `${path}.observerId`,
        `references unreported observer "${observerId}"`,
      );
    }
    if (sourceKind !== observerKind) {
      evidenceFailure(
        scenarioId,
        `${path}.source.kind`,
        `does not match observer "${observerId}" kind "${observerKind}"`,
      );
    }
    requireSha256(
      scenarioId,
      `${path}.payloadSha256`,
      observation.payloadSha256,
    );
    validateTrajectoryReferences(
      scenarioId,
      `${path}.trajectoryRefs`,
      observation.trajectoryRefs,
      trajectoryHashes,
    );

    if (kind === "durable-approval") {
      requireEvidenceString(
        scenarioId,
        `${path}.actionName`,
        observation.actionName,
      );
      const state = requireEvidenceString(
        scenarioId,
        `${path}.state`,
        observation.state,
      );
      if (!APPROVAL_STATES.has(state)) {
        evidenceFailure(
          scenarioId,
          `${path}.state`,
          `unsupported approval state "${state}"`,
        );
      }
      validateObservationHashFields(scenarioId, path, observation, [
        "approvalIdSha256",
        "requestPayloadSha256",
        "decisionPayloadSha256",
      ]);
      requireSha256(
        scenarioId,
        `${path}.approvalIdSha256`,
        observation.approvalIdSha256,
      );
      requireSha256(
        scenarioId,
        `${path}.requestPayloadSha256`,
        observation.requestPayloadSha256,
      );
    } else if (kind === "durable-draft") {
      requireEvidenceString(scenarioId, `${path}.channel`, observation.channel);
      const state = requireEvidenceString(
        scenarioId,
        `${path}.state`,
        observation.state,
      );
      if (!DRAFT_STATES.has(state)) {
        evidenceFailure(
          scenarioId,
          `${path}.state`,
          `unsupported draft state "${state}"`,
        );
      }
      for (const field of [
        "draftIdSha256",
        "recipientSetSha256",
        "contentSha256",
      ]) {
        requireSha256(scenarioId, `${path}.${field}`, observation[field]);
      }
    } else if (kind === "provider-effect") {
      requireEvidenceString(
        scenarioId,
        `${path}.provider`,
        observation.provider,
      );
      requireEvidenceString(
        scenarioId,
        `${path}.operation`,
        observation.operation,
      );
      for (const field of [
        "accountRefSha256",
        "requestSha256",
        "responseSha256",
        "providerReceiptIdSha256",
      ]) {
        requireSha256(scenarioId, `${path}.${field}`, observation[field]);
      }
      if (observation.readbackSha256 !== undefined) {
        requireSha256(
          scenarioId,
          `${path}.readbackSha256`,
          observation.readbackSha256,
        );
      }
    } else if (kind === "provider-no-effect") {
      requireEvidenceString(
        scenarioId,
        `${path}.provider`,
        observation.provider,
      );
      requireStringList(
        scenarioId,
        `${path}.effectKinds`,
        observation.effectKinds,
        1,
      );
      for (const field of [
        "accountRefSha256",
        "scopeSha256",
        "beforeSnapshotSha256",
        "afterSnapshotSha256",
      ]) {
        requireSha256(scenarioId, `${path}.${field}`, observation[field]);
      }
      if (
        observation.beforeSnapshotSha256 !== observation.afterSnapshotSha256
      ) {
        evidenceFailure(
          scenarioId,
          `${path}.afterSnapshotSha256`,
          "must equal beforeSnapshotSha256 for a provider-no-effect observation",
        );
      }
      const started = requireIsoTimestamp(
        scenarioId,
        `${path}.observationStartedAtIso`,
        observation.observationStartedAtIso,
      );
      const ended = requireIsoTimestamp(
        scenarioId,
        `${path}.observationEndedAtIso`,
        observation.observationEndedAtIso,
      );
      if (Date.parse(ended) < Date.parse(started)) {
        evidenceFailure(
          scenarioId,
          `${path}.observationEndedAtIso`,
          "must not precede observationStartedAtIso",
        );
      }
    } else {
      const state = requireEvidenceString(
        scenarioId,
        `${path}.state`,
        observation.state,
      );
      if (!SCHEDULED_TASK_STATES.has(state)) {
        evidenceFailure(
          scenarioId,
          `${path}.state`,
          `unsupported scheduled-task state "${state}"`,
        );
      }
      requireIsoTimestamp(
        scenarioId,
        `${path}.scheduledForIso`,
        observation.scheduledForIso,
      );
      requireSha256(
        scenarioId,
        `${path}.taskIdSha256`,
        observation.taskIdSha256,
      );
      requireSha256(
        scenarioId,
        `${path}.scheduleSha256`,
        observation.scheduleSha256,
      );
      validateObservationHashFields(scenarioId, path, observation, [
        "executionIdSha256",
        "resultSha256",
        "providerReceiptIdSha256",
      ]);
    }
    return kind as ScenarioEvidenceObservationKind;
  });
}

/**
 * Validate the evidence trust boundary before aggregation or serialization.
 * Legacy reports may omit both profile and evidence; they remain explicitly
 * unreported rather than receiving a fabricated simulated qualification.
 */
export function validateScenarioEvidenceReport(report: ScenarioReport): void {
  if (
    report.executionProfile !== undefined &&
    !isScenarioExecutionProfile(report.executionProfile)
  ) {
    evidenceFailure(
      report.id,
      "executionProfile",
      `unsupported profile "${String(report.executionProfile)}"`,
    );
  }
  if (
    report.evidenceScope !== undefined &&
    !isScenarioEvidenceScope(report.evidenceScope)
  ) {
    evidenceFailure(
      report.id,
      "evidenceScope",
      `unsupported scope "${String(report.evidenceScope)}"`,
    );
  }
  if (
    report.evidenceScope !== undefined &&
    report.executionProfile !== undefined &&
    (report.evidenceScope === "provider-certification") !==
      (report.executionProfile === "provider-qualified")
  ) {
    evidenceFailure(
      report.id,
      "evidenceScope",
      `scope "${report.evidenceScope}" is incompatible with executionProfile "${report.executionProfile}"`,
    );
  }
  if (
    report.evidenceScopeDefaulted === true &&
    report.evidenceScope !== "runner-fixture"
  ) {
    evidenceFailure(
      report.id,
      "evidenceScopeDefaulted",
      "defaulted classifications must use the conservative runner-fixture scope",
    );
  }
  if (report.evidence === undefined) {
    return;
  }
  if (report.executionProfile === undefined) {
    evidenceFailure(
      report.id,
      "executionProfile",
      "must be reported when evidence is present",
    );
  }

  const evidence = requireEvidenceRecord(
    report.id,
    "evidence",
    report.evidence,
  );
  if (evidence.schemaVersion !== 1) {
    evidenceFailure(report.id, "evidence.schemaVersion", "expected 1");
  }
  if (evidence.executionProfile !== report.executionProfile) {
    evidenceFailure(
      report.id,
      "evidence.executionProfile",
      `does not match scenario executionProfile "${report.executionProfile}"`,
    );
  }
  const qualification = requireEvidenceRecord(
    report.id,
    "evidence.qualification",
    evidence.qualification,
  );
  const qualificationStatus = requireEvidenceString(
    report.id,
    "evidence.qualification.status",
    qualification.status,
  );

  if (report.executionProfile === "simulated") {
    if (
      qualificationStatus !== "ineligible" ||
      qualification.publishable !== false
    ) {
      evidenceFailure(
        report.id,
        "evidence.qualification",
        "simulated evidence must be ineligible and publishable=false",
      );
    }
    requireStringList(
      report.id,
      "evidence.qualification.reasons",
      qualification.reasons,
      1,
    );
    if (
      Object.hasOwn(evidence, "observerProvenance") ||
      Object.hasOwn(evidence, "observations")
    ) {
      evidenceFailure(
        report.id,
        "evidence",
        "simulated evidence cannot carry trusted observer provenance or observations",
      );
    }
    if (evidence.trajectoryHashes !== undefined) {
      validateTrajectoryHashes(report.id, evidence.trajectoryHashes);
    }
    return;
  }

  if (
    qualificationStatus !== "qualified" &&
    qualificationStatus !== "unqualified"
  ) {
    evidenceFailure(
      report.id,
      "evidence.qualification.status",
      'provider-qualified evidence must report "qualified" or "unqualified"',
    );
  }
  const qualified = qualificationStatus === "qualified";
  if (qualification.publishable !== qualified) {
    evidenceFailure(
      report.id,
      "evidence.qualification.publishable",
      qualified
        ? "qualified evidence must be publishable=true"
        : "unqualified evidence must be publishable=false",
    );
  }
  requireStringList(
    report.id,
    "evidence.qualification.reasons",
    qualification.reasons,
    qualified ? 0 : 1,
  );
  if (
    qualified &&
    requireEvidenceArray(
      report.id,
      "evidence.qualification.reasons",
      qualification.reasons,
    ).length !== 0
  ) {
    evidenceFailure(
      report.id,
      "evidence.qualification.reasons",
      "qualified evidence cannot carry unresolved reasons",
    );
  }

  const observerKinds = validateObserverProvenance(
    report.id,
    evidence.observerProvenance,
  );
  const trajectoryHashes = validateTrajectoryHashes(
    report.id,
    evidence.trajectoryHashes,
  );
  const observationKinds = validateEvidenceObservations(
    report.id,
    evidence.observations,
    observerKinds,
    trajectoryHashes,
  );

  if (qualified) {
    if (
      observerKinds.size === 0 ||
      trajectoryHashes.size === 0 ||
      observationKinds.length === 0
    ) {
      evidenceFailure(
        report.id,
        "evidence",
        "qualified evidence requires non-empty observers, trajectories, and observations",
      );
    }
    if (
      !observationKinds.some(
        (kind) => kind === "provider-effect" || kind === "provider-no-effect",
      )
    ) {
      evidenceFailure(
        report.id,
        "evidence.observations",
        "qualification requires provider-effect or provider-no-effect evidence",
      );
    }
    if (report.status !== "passed") {
      evidenceFailure(
        report.id,
        "evidence.qualification.status",
        "a failed or skipped scenario cannot be qualified",
      );
    }
    if (report.judgeSelfGraded) {
      evidenceFailure(
        report.id,
        "judgeSelfGraded",
        "a self-graded scenario cannot be provider-qualified",
      );
    }
    if (report.finalChecks.some((check) => check.status === "skipped")) {
      evidenceFailure(
        report.id,
        "finalChecks",
        "a scenario with skipped final checks cannot be provider-qualified",
      );
    }
  }
}

function aggregateExecutionProfile(
  scenarios: readonly ScenarioReport[],
): ScenarioExecutionProfile | "mixed" | null {
  const profiles = new Set(
    scenarios.flatMap((scenario) =>
      scenario.executionProfile === undefined
        ? []
        : [scenario.executionProfile],
    ),
  );
  if (profiles.size === 0) return null;
  if (profiles.size > 1) return "mixed";
  return [...profiles][0] ?? null;
}

function aggregateEvidence(
  scenarios: readonly ScenarioReport[],
): AggregateReport["evidenceSummary"] {
  const summary: AggregateReport["evidenceSummary"] = {
    reportedScenarioCount: 0,
    unreportedScenarioCount: 0,
    qualificationCounts: {
      qualified: 0,
      unqualified: 0,
      ineligible: 0,
    },
    publishableScenarioCount: 0,
    observationCounts: {
      "durable-approval": 0,
      "durable-draft": 0,
      "provider-effect": 0,
      "provider-no-effect": 0,
      "scheduled-task": 0,
    },
  };
  for (const scenario of scenarios) {
    const evidence = scenario.evidence;
    if (!evidence) {
      summary.unreportedScenarioCount += 1;
      continue;
    }
    summary.reportedScenarioCount += 1;
    summary.qualificationCounts[evidence.qualification.status] += 1;
    if (evidence.qualification.publishable) {
      summary.publishableScenarioCount += 1;
    }
    if (evidence.executionProfile === "provider-qualified") {
      for (const observation of evidence.observations) {
        summary.observationCounts[observation.kind] += 1;
      }
    }
  }
  return summary;
}

function aggregateClassifications(
  scenarios: readonly ScenarioReport[],
): AggregateReport["classificationSummary"] {
  const summary: AggregateReport["classificationSummary"] = {
    laneCounts: {
      "pr-deterministic": 0,
      "live-only": 0,
      unreported: 0,
    },
    executionProfileCounts: {
      simulated: 0,
      "provider-qualified": 0,
      unreported: 0,
    },
    evidenceScopeCounts: {
      "runner-fixture": 0,
      "domain-contract": 0,
      "model-behavior": 0,
      "connector-contract": 0,
      "provider-certification": 0,
      unreported: 0,
    },
    defaultedEvidenceScopeCount: 0,
    selfGradedJudgeCount: 0,
  };
  for (const scenario of scenarios) {
    if (scenario.lane === "pr-deterministic" || scenario.lane === "live-only") {
      summary.laneCounts[scenario.lane] += 1;
    } else {
      summary.laneCounts.unreported += 1;
    }
    if (isScenarioExecutionProfile(scenario.executionProfile)) {
      summary.executionProfileCounts[scenario.executionProfile] += 1;
    } else {
      summary.executionProfileCounts.unreported += 1;
    }
    if (isScenarioEvidenceScope(scenario.evidenceScope)) {
      summary.evidenceScopeCounts[scenario.evidenceScope] += 1;
    } else {
      summary.evidenceScopeCounts.unreported += 1;
    }
    if (scenario.evidenceScopeDefaulted === true) {
      summary.defaultedEvidenceScopeCount += 1;
    }
    if (scenario.judgeSelfGraded === true) {
      summary.selfGradedJudgeCount += 1;
    }
  }
  return summary;
}

function evidenceSummaryMatches(
  actual: AggregateReport["evidenceSummary"],
  expected: AggregateReport["evidenceSummary"],
): boolean {
  return (
    actual.reportedScenarioCount === expected.reportedScenarioCount &&
    actual.unreportedScenarioCount === expected.unreportedScenarioCount &&
    actual.qualificationCounts.qualified ===
      expected.qualificationCounts.qualified &&
    actual.qualificationCounts.unqualified ===
      expected.qualificationCounts.unqualified &&
    actual.qualificationCounts.ineligible ===
      expected.qualificationCounts.ineligible &&
    actual.publishableScenarioCount === expected.publishableScenarioCount &&
    actual.observationCounts["durable-approval"] ===
      expected.observationCounts["durable-approval"] &&
    actual.observationCounts["durable-draft"] ===
      expected.observationCounts["durable-draft"] &&
    actual.observationCounts["provider-effect"] ===
      expected.observationCounts["provider-effect"] &&
    actual.observationCounts["provider-no-effect"] ===
      expected.observationCounts["provider-no-effect"] &&
    actual.observationCounts["scheduled-task"] ===
      expected.observationCounts["scheduled-task"]
  );
}

function classificationSummaryMatches(
  actual: AggregateReport["classificationSummary"],
  expected: AggregateReport["classificationSummary"],
): boolean {
  return (
    actual.laneCounts["pr-deterministic"] ===
      expected.laneCounts["pr-deterministic"] &&
    actual.laneCounts["live-only"] === expected.laneCounts["live-only"] &&
    actual.laneCounts.unreported === expected.laneCounts.unreported &&
    actual.executionProfileCounts.simulated ===
      expected.executionProfileCounts.simulated &&
    actual.executionProfileCounts["provider-qualified"] ===
      expected.executionProfileCounts["provider-qualified"] &&
    actual.executionProfileCounts.unreported ===
      expected.executionProfileCounts.unreported &&
    actual.evidenceScopeCounts["runner-fixture"] ===
      expected.evidenceScopeCounts["runner-fixture"] &&
    actual.evidenceScopeCounts["domain-contract"] ===
      expected.evidenceScopeCounts["domain-contract"] &&
    actual.evidenceScopeCounts["model-behavior"] ===
      expected.evidenceScopeCounts["model-behavior"] &&
    actual.evidenceScopeCounts["connector-contract"] ===
      expected.evidenceScopeCounts["connector-contract"] &&
    actual.evidenceScopeCounts["provider-certification"] ===
      expected.evidenceScopeCounts["provider-certification"] &&
    actual.evidenceScopeCounts.unreported ===
      expected.evidenceScopeCounts.unreported &&
    actual.defaultedEvidenceScopeCount ===
      expected.defaultedEvidenceScopeCount &&
    actual.selfGradedJudgeCount === expected.selfGradedJudgeCount
  );
}

/**
 * Protect every serialization path from a hand-built aggregate whose profile
 * or publishability summary disagrees with its per-scenario evidence.
 */
export function validateAggregateEvidenceReport(report: AggregateReport): void {
  for (const scenario of report.scenarios) {
    validateScenarioEvidenceReport(scenario);
  }
  const expectedProfile = aggregateExecutionProfile(report.scenarios);
  if (report.executionProfile !== expectedProfile) {
    throw new Error(
      `aggregate executionProfile "${report.executionProfile}" does not match scenario reports "${expectedProfile}"`,
    );
  }
  const expectedSummary = aggregateEvidence(report.scenarios);
  if (!evidenceSummaryMatches(report.evidenceSummary, expectedSummary)) {
    throw new Error(
      "aggregate evidenceSummary does not match validated scenario evidence",
    );
  }
  const expectedClassifications = aggregateClassifications(report.scenarios);
  if (
    !classificationSummaryMatches(
      report.classificationSummary,
      expectedClassifications,
    )
  ) {
    throw new Error(
      `aggregate classificationSummary does not match validated scenario classifications: reported=${JSON.stringify(report.classificationSummary)} expected=${JSON.stringify(expectedClassifications)}`,
    );
  }
}

/**
 * Walk `<runDir>/trajectories/**\/*.json` and sum the real per-trajectory LLM
 * spend so the aggregate report's `totalCostUsd` reflects what the run actually
 * cost instead of a hardcoded `0`.
 *
 * Each persisted trajectory carries a top-level `metrics.totalCostUsd` (summed
 * by the recorder from every model stage); we prefer that and fall back to
 * summing `stages[].model.costUsd` directly when a trajectory predates the
 * rolled-up metric. Only finite, non-negative values are counted — a corrupt
 * or unreadable trajectory contributes `0` rather than poisoning the total with
 * `NaN`. Returns `0` when no run dir / no trajectories exist (honest absence,
 * not a fabricated spend of `0` on a real live run — callers pass a runDir only
 * when trajectories were actually recorded).
 */
export function sumTrajectoryCostUsd(runDir: string | undefined): number {
  if (!runDir) return 0;
  const trajectoriesDir = path.join(runDir, "trajectories");
  if (!existsSync(trajectoriesDir)) return 0;
  let total = 0;
  for (const file of collectFiles(trajectoriesDir)) {
    if (!file.endsWith(".json")) continue;
    const payload = asRecord(readJsonFile(file));
    const rolled = asNumber(asRecord(payload.metrics).totalCostUsd);
    if (rolled !== null && rolled >= 0) {
      total += rolled;
      continue;
    }
    // Fallback: sum stage-level costs for trajectories without a rolled metric.
    const stages = Array.isArray(payload.stages) ? payload.stages : [];
    for (const stage of stages) {
      const stageCost = asNumber(asRecord(asRecord(stage).model).costUsd);
      if (stageCost !== null && stageCost >= 0) total += stageCost;
    }
  }
  return total;
}

export function buildAggregate(
  scenarios: ScenarioReport[],
  providerName: string | null,
  startedAtIso: string,
  completedAtIso: string,
  runId: string,
  runDir?: string,
): AggregateReport {
  const totals = {
    passed: 0,
    failed: 0,
    skipped: 0,
    costUsd: 0,
    finalChecksSkipped: 0,
  };
  for (const s of scenarios) {
    validateScenarioEvidenceReport(s);
    if (s.status === "passed") totals.passed += 1;
    else if (s.status === "failed") totals.failed += 1;
    else totals.skipped += 1;
    for (const check of s.finalChecks) {
      if (check.status === "skipped") totals.finalChecksSkipped += 1;
    }
  }
  totals.costUsd = sumTrajectoryCostUsd(runDir);
  const executionProfile = aggregateExecutionProfile(scenarios);
  const evidenceSummary = aggregateEvidence(scenarios);
  const classificationSummary = aggregateClassifications(scenarios);
  return {
    runId,
    startedAtIso,
    completedAtIso,
    providerName,
    executionProfile,
    scenarios,
    classificationSummary,
    evidenceSummary,
    totals,
    totalCount: scenarios.length,
    passedCount: totals.passed,
    failedCount: totals.failed,
    skippedCount: totals.skipped,
    totalCostUsd: totals.costUsd,
  };
}

export function writeReport(report: AggregateReport, filePath: string): void {
  validateAggregateEvidenceReport(report);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, `${JSON.stringify(report, null, 2)}\n`);
  logger.info(`[scenario-runner] wrote report → ${filePath}`);
}

export function writeFileAtomic(filePath: string, body: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tmpPath, body, "utf-8");
  renameSync(tmpPath, filePath);
}

function scenarioReportFileName(id: string, index: number): string {
  const sanitizedId = id.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${String(index + 1).padStart(3, "0")}-${sanitizedId}.json`;
}

export function writeReportBundle(
  report: AggregateReport,
  reportDir: string,
): void {
  validateAggregateEvidenceReport(report);
  mkdirSync(reportDir, { recursive: true });

  const matrixPath = path.join(reportDir, "matrix.json");
  writeFileAtomic(matrixPath, `${JSON.stringify(report, null, 2)}\n`);

  report.scenarios.forEach((scenarioReport, index) => {
    const scenarioPath = path.join(
      reportDir,
      scenarioReportFileName(scenarioReport.id, index),
    );
    writeFileAtomic(
      scenarioPath,
      `${JSON.stringify(scenarioReport, null, 2)}\n`,
    );
  });

  logger.info(`[scenario-runner] wrote report bundle → ${reportDir}`);
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function readJsonlFile(filePath: string, maxRows = 5_000): unknown[] {
  try {
    const rows: unknown[] = [];
    for (const line of readFileSync(filePath, "utf-8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        rows.push({ _raw: trimmed });
      }
      if (rows.length >= maxRows) break;
    }
    return rows;
  } catch {
    return [];
  }
}

function collectFiles(rootDir: string, maxFiles = 500): string[] {
  if (!existsSync(rootDir)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (stat.isFile()) out.push(full);
      if (out.length >= maxFiles) return;
    }
  };
  walk(rootDir);
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function truncateText(value: unknown, maxLength = 420): string {
  const text =
    typeof value === "string"
      ? value
      : value == null
        ? ""
        : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function summarizeTrajectoryFile(
  filePath: string,
  payload: unknown,
): Record<string, unknown> {
  const root = asRecord(payload);
  const stages = Array.isArray(root.stages) ? root.stages : [];
  const stageSummaries = stages.map((stage, index) => {
    const item = asRecord(stage);
    const model = asRecord(item.model);
    const usage = asRecord(model.usage);
    const cache = asRecord(item.cache);
    const tool = asRecord(item.tool);
    const toolSearch = asRecord(item.toolSearch);
    const evaluation = asRecord(item.evaluation);
    const promptTokens = asNumber(usage.promptTokens);
    const completionTokens = asNumber(usage.completionTokens);
    const totalTokens = asNumber(usage.totalTokens);
    const cacheReadTokens = asNumber(usage.cacheReadInputTokens);
    const cachePercent =
      promptTokens && cacheReadTokens !== null
        ? (cacheReadTokens / promptTokens) * 100
        : null;
    return {
      index,
      stageId: item.stageId,
      kind: item.kind,
      iteration: item.iteration,
      latencyMs: item.latencyMs,
      modelType: model.modelType,
      modelName: model.modelName,
      provider: model.provider,
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadTokens,
      cachePercent,
      costUsd: asNumber(model.costUsd),
      cachePrefixHash: cache.prefixHash,
      cacheSegmentCount: Array.isArray(cache.segmentHashes)
        ? cache.segmentHashes.length
        : null,
      toolName: tool.name,
      toolSuccess: tool.success,
      toolError: tool.errorText,
      toolInputPreview: truncateText(tool.input),
      toolOutputPreview: truncateText(tool.output),
      toolSearchQuery: truncateText(asRecord(toolSearch.query).text),
      toolSearchTopResults: Array.isArray(toolSearch.results)
        ? toolSearch.results.slice(0, 5).map((result) => {
            const row = asRecord(result);
            return {
              name: row.name,
              score: row.score,
              rank: row.rank,
              matchedBy: row.matchedBy,
            };
          })
        : [],
      evaluationVerdict: evaluation.verdict,
      responsePreview: truncateText(model.response),
    };
  });
  return {
    path: filePath,
    trajectoryId: root.trajectoryId,
    scenarioId: root.scenarioId,
    status: root.status,
    metrics: root.metrics ?? null,
    stages: stageSummaries,
  };
}

function defaultNativeManifestPath(
  nativeJsonlPath?: string,
): string | undefined {
  if (!nativeJsonlPath) return undefined;
  return nativeJsonlPath.endsWith(".jsonl")
    ? `${nativeJsonlPath.slice(0, -".jsonl".length)}.manifest.json`
    : `${nativeJsonlPath}.manifest.json`;
}

function buildScenarioViewerPayload(
  report: AggregateReport,
  runDir: string,
  nativeJsonlPath?: string,
): Record<string, unknown> {
  const trajectoriesDir = path.join(runDir, "trajectories");
  const nativeManifestPath = defaultNativeManifestPath(nativeJsonlPath);
  const trajectoryFiles = collectFiles(trajectoriesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      path: path.relative(runDir, file),
      payload: readJsonFile(file),
    }));
  const trajectorySummaries = trajectoryFiles.map((file) =>
    summarizeTrajectoryFile(file.path, file.payload),
  );
  const nativeRows =
    nativeJsonlPath && existsSync(nativeJsonlPath)
      ? readJsonlFile(nativeJsonlPath)
      : [];
  return {
    schema: "eliza_scenario_run_viewer_v1",
    generatedAt: new Date().toISOString(),
    runDir,
    matrixPath: path.join(runDir, "matrix.json"),
    nativeJsonlPath: nativeJsonlPath ?? null,
    nativeManifestPath: nativeManifestPath ?? null,
    report,
    trajectories: {
      root: trajectoriesDir,
      files: trajectoryFiles,
      summaries: trajectorySummaries,
    },
    nativeExport: {
      manifest:
        nativeManifestPath && existsSync(nativeManifestPath)
          ? readJsonFile(nativeManifestPath)
          : null,
      rows: nativeRows,
    },
  };
}

function scenarioViewerHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Eliza Scenario Run Viewer</title>
  <style>
    :root { --bg:#f7f8f5; --panel:#fff; --ink:#182018; --muted:#5d665c; --line:#d8ded2; --ok:#17633a; --bad:#a12222; --accent:#116b5b; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { position:sticky; top:0; z-index:2; background:#fff; border-bottom:1px solid var(--line); padding:16px 20px; }
    h1 { margin:0 0 6px; font-size:22px; letter-spacing:0; }
    .muted { color:var(--muted); }
    .notice { margin-top:8px; border:1px solid #d69a38; border-radius:6px; background:#fff7e6; color:#6b4300; padding:7px 9px; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; padding:14px 20px; }
    .card,.panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; margin-top:3px; font-size:20px; }
    main { display:grid; grid-template-columns:330px 1fr; gap:12px; padding:0 20px 20px; }
    .panel { overflow:hidden; margin-bottom:12px; }
    .panel h2 { margin:0; padding:10px 12px; font-size:14px; border-bottom:1px solid var(--line); background:#f2f5ef; }
    .controls { display:grid; gap:8px; padding:10px; }
    input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:7px 8px; background:#fff; color:var(--ink); }
    .scenario-list { max-height:62vh; overflow:auto; }
    .scenario-item { width:100%; border:0; border-bottom:1px solid var(--line); background:#fff; padding:10px; text-align:left; cursor:pointer; }
    .scenario-item:hover,.scenario-item.active { background:#eef6f2; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:1px 6px; margin:2px 3px 0 0; font-size:11px; color:var(--muted); }
    .passed { color:var(--ok); font-weight:600; }
    .failed { color:var(--bad); font-weight:600; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid var(--line); padding:7px; text-align:left; vertical-align:top; }
    th { background:#f7faf4; position:sticky; top:65px; }
    details { border-top:1px solid var(--line); }
    summary { cursor:pointer; padding:9px 12px; background:#fff; }
    pre { margin:0; max-height:520px; overflow:auto; white-space:pre-wrap; word-break:break-word; background:#101510; color:#eef7ea; padding:10px 12px; }
    .turn { border-top:1px solid var(--line); padding:10px 12px; }
    .audio-artifact { display:flex; flex-direction:column; gap:2px; margin-bottom:6px; }
    .audio-artifact audio { width:200px; height:30px; }
    @media (max-width:900px) { main { grid-template-columns:1fr; } th { top:0; } }
  </style>
</head>
<body>
  <header><h1>Eliza Scenario Run Viewer</h1><div id="meta" class="muted"></div><div id="trust-banner" class="notice"></div></header>
  <div id="cards" class="cards"></div>
  <main>
    <aside class="panel">
      <h2>Scenarios</h2>
      <div class="controls">
        <input id="search" type="search" placeholder="Search scenario, status, tag..." />
        <select id="status"><option value="">all statuses</option></select>
      </div>
      <div id="scenario-list" class="scenario-list"></div>
    </aside>
    <section class="panel">
      <h2 id="detail-title">Scenario Detail</h2>
      <div id="detail"></div>
    </section>
  </main>
  <script src="./data.js"></script>
  <script>
    const data = window.SCENARIO_RUN_DATA || { report:{ scenarios:[], totals:{} }, trajectories:{ files:[], summaries:[] }, nativeExport:{ rows:[] } };
    let activeId = "";
    const text = v => v === null || v === undefined ? "" : String(v);
    const esc = v => text(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const json = v => esc(JSON.stringify(v, null, 2));
    function trajectoryMatches(id) {
      return (data.trajectories.files || []).filter(f => JSON.stringify(f.payload || {}).includes(id));
    }
    function trajectorySummaryMatches(id) {
      return (data.trajectories.summaries || []).filter(f => f.scenarioId === id || JSON.stringify(f).includes(id));
    }
    function nativeMatches(id) {
      return (data.nativeExport.rows || []).filter(r => r.scenarioId === id || r.metadata?.scenario_id === id);
    }
    function renderCards() {
      const r = data.report || {}, t = r.totals || {};
      document.getElementById("meta").textContent = \`\${data.runDir || ""} · provider=\${r.providerName || ""} · \${r.startedAtIso || ""} → \${r.completedAtIso || ""}\`;
      const c = r.classificationSummary || {}, scopes = c.evidenceScopeCounts || {};
      const certified = scopes["provider-certification"] || 0;
      const defaulted = c.defaultedEvidenceScopeCount || 0;
      document.getElementById("trust-banner").textContent = certified > 0
        ? \`Provider-certification scope specifications: \${certified}; publishable qualified results: \${r.evidenceSummary?.publishableScenarioCount || 0}.\`
        : \`No provider certification is claimed. Simulated passes are diagnostic/contract evidence only.\${defaulted ? " " + defaulted + " scenario(s) use the conservative legacy runner-fixture default." : ""}\`;
      const items = [["Scenarios", r.totalCount || 0], ["Passed", t.passed || 0], ["Failed", t.failed || 0], ["Skipped", t.skipped || 0], ["Trajectory files", data.trajectories?.files?.length || 0], ["Native rows", data.nativeExport?.rows?.length || 0]];
      document.getElementById("cards").innerHTML = items.map(([k,v]) => \`<div class="card"><span class="muted">\${esc(k)}</span><b>\${esc(v)}</b></div>\`).join("");
    }
    function filtered() {
      const q = document.getElementById("search").value.toLowerCase();
      const st = document.getElementById("status").value;
      return (data.report.scenarios || []).filter(s => {
        const hay = [s.id, s.title, s.domain, s.status, ...(s.tags || [])].map(text).join(" ").toLowerCase();
        return (!q || hay.includes(q)) && (!st || s.status === st);
      });
    }
    function renderFilters() {
      const statuses = [...new Set((data.report.scenarios || []).map(s => s.status).filter(Boolean))].sort();
      document.getElementById("status").innerHTML = '<option value="">all statuses</option>' + statuses.map(s => \`<option>\${esc(s)}</option>\`).join("");
    }
    function renderList() {
      const rows = filtered();
      if (!activeId && rows.length) activeId = rows[0].id;
      if (!rows.some(r => r.id === activeId) && rows.length) activeId = rows[0].id;
      document.getElementById("scenario-list").innerHTML = rows.map(s => \`<button class="scenario-item \${s.id === activeId ? "active" : ""}" data-id="\${esc(s.id)}"><strong>\${esc(s.id)}</strong><br><span class="\${esc(s.status)}">\${esc(s.status)}</span> <span class="muted">\${esc(s.durationMs)}ms</span></button>\`).join("");
      renderDetail();
    }
    function audioArtifactsCell(t) {
      const artifacts = t.audioArtifacts || [];
      if (!artifacts.length) return "";
      // The viewer html lives in <runDir>/viewer/; artifact paths are run-dir
      // relative, so prefix "../" to resolve them from the viewer document.
      return artifacts.map(a => {
        const label = [a.kind, "turn " + a.turnIndex, a.speakerLabel].filter(Boolean).join(" · ");
        return \`<div class="audio-artifact"><span class="muted">\${esc(label)}</span><audio controls preload="none" src="../\${esc(a.path)}"></audio></div>\`;
      }).join("");
    }
    function turnsTable(s) {
      const turns = s.turns || [];
      if (!turns.length) return '<div class="turn muted">No turn reports.</div>';
      return '<table><thead><tr><th>turn</th><th>kind</th><th>status</th><th>input</th><th>response</th><th>actions</th><th>audio</th></tr></thead><tbody>' + turns.map(t => \`<tr><td>\${esc(t.name)}</td><td>\${esc(t.kind)}</td><td>\${esc((t.failedAssertions||[]).length ? "failed" : "ok")}</td><td>\${esc(t.text)}</td><td>\${esc(t.responseText)}</td><td>\${esc((t.actionsCalled||[]).map(a => a.name || a.actionName || "").join(", "))}</td><td>\${audioArtifactsCell(t)}</td></tr>\`).join("") + '</tbody></table>';
    }
    function fmtNum(v) {
      return typeof v === "number" && Number.isFinite(v) ? Math.round(v).toLocaleString() : "";
    }
    function fmtPct(v) {
      return typeof v === "number" && Number.isFinite(v) ? v.toFixed(1) + "%" : "";
    }
    function stageLabel(stage) {
      const parts = [stage.kind || "", stage.iteration ? "iter " + stage.iteration : "", stage.modelName || stage.toolName || ""].filter(Boolean);
      return parts.join(" · ") || "stage " + stage.index;
    }
    function stageRows(summary) {
      const stages = summary.stages || [];
      if (!stages.length) return '<div class="turn muted">No stage summary.</div>';
      return '<table><thead><tr><th>#</th><th>stage</th><th>latency</th><th>tokens</th><th>cache</th><th>tool/result</th><th>preview</th></tr></thead><tbody>' + stages.map(stage => {
        const toolBits = [stage.toolName, stage.toolSuccess === true ? "ok" : stage.toolSuccess === false ? "failed" : "", stage.toolError].filter(Boolean).join(" · ");
        const preview = stage.responsePreview || stage.toolInputPreview || stage.toolSearchQuery || "";
        return \`<tr>
          <td>\${esc(stage.index)}</td>
          <td>\${esc(stageLabel(stage))}<br><span class="muted">\${esc(stage.stageId || "")}</span></td>
          <td>\${esc(stage.latencyMs || "")}ms</td>
          <td>prompt \${esc(fmtNum(stage.promptTokens))}<br>completion \${esc(fmtNum(stage.completionTokens))}<br>total \${esc(fmtNum(stage.totalTokens))}</td>
          <td>read \${esc(fmtNum(stage.cacheReadTokens))}<br>\${esc(fmtPct(stage.cachePercent))}<br><span class="muted">\${esc(stage.cacheSegmentCount ?? "")} segments</span></td>
          <td>\${esc(toolBits || stage.evaluationVerdict || "")}</td>
          <td>\${esc(preview)}</td>
        </tr>\`;
      }).join("") + '</tbody></table>';
    }
    function trajectorySummarySection(summaries) {
      if (!summaries.length) return '<div class="turn muted">No trajectory summaries for this scenario.</div>';
      return summaries.map(summary => \`<details open><summary>\${esc(summary.path)} · \${esc(summary.status || "")}</summary>
        <div class="turn"><strong>metrics</strong><pre>\${json(summary.metrics)}</pre></div>
        \${stageRows(summary)}
      </details>\`).join("");
    }
    function renderDetail() {
      const s = (data.report.scenarios || []).find(row => row.id === activeId);
      document.getElementById("detail-title").textContent = activeId || "Scenario Detail";
      if (!s) { document.getElementById("detail").innerHTML = '<div class="turn muted">No matching scenario.</div>'; return; }
      const traj = trajectoryMatches(s.id);
      const trajSummaries = trajectorySummaryMatches(s.id);
      const native = nativeMatches(s.id);
      document.getElementById("detail").innerHTML = \`
        <div class="turn"><strong class="\${esc(s.status)}">\${esc(s.status)}</strong> · \${esc(s.title)} · \${esc(s.domain)} · scope: \${esc(s.evidenceScope || "unreported")}\${s.evidenceScopeDefaulted ? " (legacy default; classification debt)" : ""} · \${esc((s.tags||[]).join(", "))}</div>
        \${turnsTable(s)}
        <details open><summary>Call-by-call trajectory summary (\${trajSummaries.length})</summary>\${trajectorySummarySection(trajSummaries)}</details>
        <details open><summary>Native model-boundary rows (\${native.length})</summary>\${native.map((row,i) => \`<div class="turn"><strong>row \${i}</strong><pre>\${json(row)}</pre></div>\`).join("") || '<div class="turn muted">No native rows for this scenario.</div>'}</details>
        <details><summary>Recorded trajectory files (\${traj.length})</summary>\${traj.map(f => \`<details><summary>\${esc(f.path)}</summary><pre>\${json(f.payload)}</pre></details>\`).join("") || '<div class="turn muted">No recorded trajectory files for this scenario.</div>'}</details>
        <details><summary>Scenario report JSON</summary><pre>\${json(s)}</pre></details>\`;
    }
    document.addEventListener("click", e => { const b = e.target.closest(".scenario-item"); if (b) { activeId = b.dataset.id; renderList(); } });
    document.getElementById("search").addEventListener("input", renderList);
    document.getElementById("status").addEventListener("change", renderList);
    renderCards(); renderFilters(); renderList();
  </script>
</body>
</html>`;
}

export function writeScenarioRunViewer(
  report: AggregateReport,
  runDir: string,
  options: { nativeJsonlPath?: string } = {},
): { viewerIndex: string; viewerData: string; nativeManifest?: string } {
  validateAggregateEvidenceReport(report);
  const viewerDir = path.join(runDir, "viewer");
  mkdirSync(viewerDir, { recursive: true });
  const viewerIndex = path.join(viewerDir, "index.html");
  const viewerData = path.join(viewerDir, "data.js");
  const payload = buildScenarioViewerPayload(
    report,
    runDir,
    options.nativeJsonlPath,
  );
  writeFileAtomic(viewerIndex, scenarioViewerHtml());
  writeFileAtomic(
    viewerData,
    `window.SCENARIO_RUN_DATA = ${JSON.stringify(payload)};\n`,
  );
  logger.info(`[scenario-runner] wrote run viewer → ${viewerIndex}`);
  return {
    viewerIndex,
    viewerData,
    nativeManifest: defaultNativeManifestPath(options.nativeJsonlPath),
  };
}

export function printStdoutSummary(report: AggregateReport): void {
  validateAggregateEvidenceReport(report);
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `Scenario run ${report.runId} | provider=${report.providerName ?? "(none)"} | profile=${report.executionProfile ?? "(unreported)"} | ${report.startedAtIso} → ${report.completedAtIso}`,
  );
  lines.push("| id | status | duration | failures |");
  lines.push("| --- | --- | --- | --- |");
  for (const s of report.scenarios) {
    const first =
      s.failedAssertions[0]?.detail ?? s.error ?? s.skipReason ?? "";
    const detail = first
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ")
      .slice(0, 140);
    lines.push(`| ${s.id} | ${s.status} | ${s.durationMs}ms | ${detail} |`);
  }
  lines.push("");
  lines.push(
    `Totals: ${report.totals.passed} passed, ${report.totals.failed} failed, ${report.totals.skipped} skipped of ${report.totalCount}`,
  );
  lines.push(
    `Evidence: ${report.evidenceSummary.qualificationCounts.qualified} qualified, ${report.evidenceSummary.qualificationCounts.unqualified} unqualified, ${report.evidenceSummary.qualificationCounts.ineligible} ineligible, ${report.evidenceSummary.unreportedScenarioCount} unreported; ${report.evidenceSummary.publishableScenarioCount} publishable`,
  );
  lines.push(
    `Scopes: ${Object.entries(report.classificationSummary.evidenceScopeCounts)
      .map(([scope, count]) =>
        scope === "unreported"
          ? `${count} unreported`
          : `${count} ${scenarioEvidenceScopeLabel(scope as ScenarioEvidenceScope)}`,
      )
      .join(", ")}`,
  );
  if (report.executionProfile !== "provider-qualified") {
    lines.push(
      "NOTICE: simulated scenario passes are diagnostic/contract evidence, not provider certification.",
    );
  }
  if (report.classificationSummary.defaultedEvidenceScopeCount > 0) {
    lines.push(
      `WARNING: ${report.classificationSummary.defaultedEvidenceScopeCount} scenario(s) omitted evidenceScope and were conservatively labeled runner fixture; classify this migration debt explicitly.`,
    );
  }
  if (report.totals.finalChecksSkipped > 0) {
    lines.push(
      `WARNING: ${report.totals.finalChecksSkipped} finalCheck(s) skipped (dependency missing) — those checks proved nothing this run:`,
    );
    for (const s of report.scenarios) {
      for (const check of s.finalChecks) {
        if (check.status === "skipped") {
          lines.push(`  - ${s.id} :: ${check.label}: ${check.detail}`);
        }
      }
    }
  }
  const selfGraded = report.scenarios.filter((s) => s.judgeSelfGraded);
  if (selfGraded.length > 0) {
    lines.push(
      `WARNING: ${selfGraded.length} scenario(s) were JUDGED BY THE MODEL UNDER TEST (judgeSelfGraded) — no independent judge configured. ` +
        "Set CEREBRAS_API_KEY (or EVAL_CEREBRAS_API_KEY) so scores are independent; " +
        "SCENARIO_JUDGE_REQUIRE_INDEPENDENT=1 fails these scenarios instead (#9310):",
    );
    for (const s of selfGraded) {
      lines.push(`  - ${s.id}`);
    }
  }
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}
