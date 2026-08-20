/**
 * Assembles the canonical publication artifact for one externally controlled
 * provider canary. It binds the runner report to the authored manifest and
 * replaces runner-authored evidence with independently signed observations;
 * it never executes ingress or manufactures provider evidence.
 */

import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import type { ScenarioReport } from "../types.ts";
import {
  canonicalJsonValue,
  canonicalSha256,
  type ProviderQualificationManifest,
} from "./manifest.ts";
import {
  deriveProviderQualification,
  type LocalFinalCheckResult,
  type ProviderQualificationDecision,
  type ProviderQualificationManifestSignature,
  type SignedProviderObserverEvidence,
  type SignedSemanticJudgeEvidence,
} from "./qualification.ts";
import type { VerifiedScenarioTrajectorySet } from "./trajectory-verifier.ts";

export const PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA =
  "eliza.provider-qualification-artifact.v2" as const;

export interface ProviderQualificationArtifactInput {
  scenarioDefinition: ScenarioDefinition;
  manifest: ProviderQualificationManifest;
  manifestSignature: ProviderQualificationManifestSignature;
  pinnedManifestAuthorityPublicKeysPem: readonly [string, ...string[]];
  trajectories: VerifiedScenarioTrajectorySet;
  signedEvidence: SignedProviderObserverEvidence;
  pinnedObserverPublicKeysPem: readonly [string, ...string[]];
  signedSemanticEvidence: SignedSemanticJudgeEvidence;
  pinnedSemanticJudgePublicKeysPem: readonly [string, ...string[]];
  runnerReport: ScenarioReport;
  nowIso: string;
  maxSignatureAgeMs?: number;
  maxClockSkewMs?: number;
}

export interface ProviderQualificationArtifact {
  schema: typeof PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA;
  artifactSha256: string;
  createdAtIso: string;
  scenarioId: string;
  runId: string;
  repositorySha: string;
  deploymentSha: string;
  manifestSha256: string;
  trajectorySetSha256: string;
  runnerResultSha256: string;
  observerEvidenceSha256: string;
  semanticEvidenceSha256: string;
  decision: ProviderQualificationDecision;
  qualifiedReport?: ScenarioReport;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Validate a persisted artifact before catalog rendering or report merging. */
export function validateProviderQualificationArtifact(
  value: unknown,
): ProviderQualificationArtifact {
  const artifact = snapshot(
    value,
    "providerQualificationArtifact",
  ) as unknown as ProviderQualificationArtifact;
  const keys = new Set([
    "schema",
    "artifactSha256",
    "createdAtIso",
    "scenarioId",
    "runId",
    "repositorySha",
    "deploymentSha",
    "manifestSha256",
    "trajectorySetSha256",
    "runnerResultSha256",
    "observerEvidenceSha256",
    "semanticEvidenceSha256",
    "decision",
    "qualifiedReport",
  ]);
  const artifactKeys = Object.keys(artifact);
  const missing = [...keys].filter(
    (key) => key !== "qualifiedReport" && !Object.hasOwn(artifact, key),
  );
  const unknown = artifactKeys.filter((key) => !keys.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `provider qualification artifact violates the closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
  if (
    artifact.schema !== PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA ||
    typeof artifact.artifactSha256 !== "string" ||
    !SHA256_PATTERN.test(artifact.artifactSha256)
  ) {
    throw new Error(
      "provider qualification artifact schema or digest is invalid",
    );
  }
  const { artifactSha256, ...core } = artifact;
  if (
    canonicalSha256(core, "providerQualificationArtifact") !== artifactSha256
  ) {
    throw new Error("provider qualification artifact digest does not match");
  }
  if (
    artifact.decision.manifestSha256 !== artifact.manifestSha256 ||
    (artifact.decision.qualification.publishable &&
      artifact.qualifiedReport === undefined) ||
    (!artifact.decision.qualification.publishable &&
      artifact.qualifiedReport !== undefined)
  ) {
    throw new Error("provider qualification artifact decision is inconsistent");
  }
  return artifact;
}

function snapshot<T>(value: T, path: string): T {
  return canonicalJsonValue(value, path) as T;
}

function localFinalCheckResults(
  manifest: ProviderQualificationManifest,
  report: ScenarioReport,
): readonly LocalFinalCheckResult[] {
  if (report.finalChecks.length !== manifest.scenario.finalChecks.length) {
    throw new Error(
      `runner report final-check count ${report.finalChecks.length} does not match manifest count ${manifest.scenario.finalChecks.length}`,
    );
  }
  return manifest.scenario.finalChecks.map((definition, index) => {
    const result = report.finalChecks[index];
    if (!result || result.type !== definition.type) {
      throw new Error(
        `runner report finalChecks[${index}] type does not match manifest (${result?.type ?? "missing"} != ${definition.type})`,
      );
    }
    return {
      definitionSha256: definition.definitionSha256,
      status: result.status,
    };
  });
}

function requireRunnerBinding(
  scenario: ScenarioDefinition,
  manifest: ProviderQualificationManifest,
  report: ScenarioReport,
): void {
  if (report.id !== scenario.id || manifest.scenario.id !== scenario.id) {
    throw new Error(
      `runner, manifest, and authored scenario IDs must match (${report.id}, ${manifest.scenario.id}, ${scenario.id})`,
    );
  }
  if (
    report.executionProfile !== "provider-qualified" ||
    report.evidence?.executionProfile !== "provider-qualified"
  ) {
    throw new Error(
      "runner report must be an unmodified provider-qualified report",
    );
  }
}

function qualifiedReport(
  report: ScenarioReport,
  decision: ProviderQualificationDecision,
  trajectories: VerifiedScenarioTrajectorySet,
  evidence: SignedProviderObserverEvidence,
): ScenarioReport | undefined {
  if (!decision.qualification.publishable) return undefined;
  if (
    !decision.guarantees.providerAuthorizationVerified ||
    !decision.guarantees.providerAcceptanceVerified ||
    !decision.guarantees.providerReadbackVerified ||
    !decision.guarantees.providerIdempotencyVerified
  ) {
    throw new Error(
      "publishable provider qualification lacks an authorization, acceptance, readback, or idempotency guarantee",
    );
  }
  const trajectoryHashes = trajectories.trajectories.map(
    (trajectory) => trajectory.artifact,
  );
  if (
    trajectoryHashes.length === 0 ||
    evidence.payload.observerProvenance.length === 0 ||
    evidence.payload.observations.length === 0
  ) {
    throw new Error(
      "qualified provider evidence cannot contain empty proof sets",
    );
  }
  const nonEmptyTrajectoryHashes = trajectoryHashes as [
    (typeof trajectoryHashes)[number],
    ...(typeof trajectoryHashes)[number][],
  ];
  const nonEmptyObserverProvenance = evidence.payload.observerProvenance as [
    (typeof evidence.payload.observerProvenance)[number],
    ...(typeof evidence.payload.observerProvenance)[number][],
  ];
  const nonEmptyObservations = evidence.payload.observations as [
    (typeof evidence.payload.observations)[number],
    ...(typeof evidence.payload.observations)[number][],
  ];
  return snapshot(
    {
      ...report,
      evidence: {
        schemaVersion: 1,
        executionProfile: "provider-qualified",
        qualification: decision.qualification,
        observerProvenance: nonEmptyObserverProvenance,
        trajectoryHashes: nonEmptyTrajectoryHashes,
        observations: nonEmptyObservations,
      },
    } satisfies ScenarioReport,
    "qualifiedReport",
  );
}

/**
 * Recompute a qualification decision and its publishable report projection.
 * An unqualified decision is returned for diagnostics but never gains a
 * `qualifiedReport`, so callers cannot accidentally publish runner assertions.
 */
export function assembleProviderQualificationArtifact(
  rawInput: ProviderQualificationArtifactInput,
): ProviderQualificationArtifact {
  const input = snapshot(rawInput, "providerQualificationArtifactInput");
  requireRunnerBinding(
    input.scenarioDefinition,
    input.manifest,
    input.runnerReport,
  );
  const finalChecks = localFinalCheckResults(
    input.manifest,
    input.runnerReport,
  );
  const decision = deriveProviderQualification({
    scenarioDefinition: input.scenarioDefinition,
    manifest: input.manifest,
    manifestSignature: input.manifestSignature,
    pinnedManifestAuthorityPublicKeysPem:
      input.pinnedManifestAuthorityPublicKeysPem,
    trajectories: input.trajectories,
    signedEvidence: input.signedEvidence,
    pinnedObserverPublicKeysPem: input.pinnedObserverPublicKeysPem,
    signedSemanticEvidence: input.signedSemanticEvidence,
    pinnedSemanticJudgePublicKeysPem: input.pinnedSemanticJudgePublicKeysPem,
    scenarioStatus: input.runnerReport.status,
    finalChecks,
    nowIso: input.nowIso,
    ...(input.maxSignatureAgeMs === undefined
      ? {}
      : { maxSignatureAgeMs: input.maxSignatureAgeMs }),
    ...(input.maxClockSkewMs === undefined
      ? {}
      : { maxClockSkewMs: input.maxClockSkewMs }),
  });
  const report = qualifiedReport(
    input.runnerReport,
    decision,
    input.trajectories,
    input.signedEvidence,
  );
  const core = {
    schema: PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA,
    createdAtIso: input.nowIso,
    scenarioId: input.scenarioDefinition.id,
    runId: input.manifest.run.runId,
    repositorySha: input.manifest.run.repositorySha,
    deploymentSha: input.manifest.run.deploymentSha,
    manifestSha256: input.manifest.manifestSha256,
    trajectorySetSha256: input.trajectories.setSha256,
    runnerResultSha256: input.signedEvidence.payload.runnerResultSha256,
    observerEvidenceSha256: canonicalSha256(
      input.signedEvidence,
      "signedEvidence",
    ),
    semanticEvidenceSha256: canonicalSha256(
      input.signedSemanticEvidence,
      "signedSemanticEvidence",
    ),
    decision,
    ...(report === undefined ? {} : { qualifiedReport: report }),
  };
  return snapshot(
    {
      ...core,
      artifactSha256: canonicalSha256(core, "providerQualificationArtifact"),
    },
    "providerQualificationArtifact",
  );
}
