/**
 * Assembles a portable, independently re-verifiable evidence capsule for one
 * externally controlled provider canary. The capsule retains only public keys,
 * signed hash-only evidence, verified trajectory inventory, and runner result
 * projections; private targets, credentials, and runner transcripts stay out.
 */

import { createPublicKey, type KeyObject } from "node:crypto";
import path from "node:path";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import type { ScenarioReport } from "../types.ts";
import {
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
  type ProviderQualificationManifest,
} from "./manifest.ts";
import {
  deriveProviderQualification,
  type LocalFinalCheckResult,
  type ProviderQualificationDecision,
  type ProviderQualificationManifestSignature,
  providerObserverKeyId,
  runnerResultSha256,
  type SignedProviderObserverEvidence,
  type SignedSemanticJudgeEvidence,
} from "./qualification.ts";
import type {
  VerifiedScenarioTrajectory,
  VerifiedScenarioTrajectorySet,
} from "./trajectory-verifier.ts";

export const PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA =
  "eliza.provider-qualification-artifact.v4" as const;
export const PROVIDER_QUALIFICATION_VERIFIER_TRANSCRIPT_SCHEMA =
  "eliza.provider-qualification-verifier-transcript.v1" as const;

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

export interface ProviderQualificationPublicKeyPin {
  keyId: string;
  algorithm: "ed25519";
  spkiPem: string;
}

export interface PortableVerifiedScenarioTrajectorySet {
  runId: string;
  scenarioId: string;
  scenarioStartedAtIso: string;
  scenarioEndedAtIso: string;
  verifiedAtIso: string;
  setSha256: string;
  trajectories: readonly [
    VerifiedScenarioTrajectory,
    ...VerifiedScenarioTrajectory[],
  ];
}

export interface ProviderRunnerResultProjection {
  scenarioStatus: "passed" | "failed" | "skipped";
  finalChecks: readonly LocalFinalCheckResult[];
  runnerResultSha256: string;
}

export interface ProviderQualifiedReportProjection {
  scenarioId: string;
  status: "passed";
  executionProfile: "provider-qualified";
  evidenceScope: "provider-certification";
  qualification: ProviderQualificationDecision["qualification"];
  runnerResultSha256: string;
  trajectorySetSha256: string;
  observerEvidenceSha256: string;
  semanticEvidenceSha256: string;
}

export interface ProviderQualificationVerifierTranscript {
  schema: typeof PROVIDER_QUALIFICATION_VERIFIER_TRANSCRIPT_SCHEMA;
  implementation: "@elizaos/scenario-runner/provider-qualification";
  verifiedAtIso: string;
  verificationOptions: {
    maxSignatureAgeMs?: number;
    maxClockSkewMs?: number;
  };
  sourcePrivacy: {
    privateProviderTargetsRetained: false;
    privateKeysRetained: false;
    credentialsRetained: false;
    rawRunnerTranscriptRetained: false;
    runDirectoryPathRetained: false;
  };
  inventory: {
    trajectoryCount: number;
    trajectoryStageCount: number;
    runnerFinalCheckCount: number;
    observationCount: number;
    failureProbeObservationCount: number;
    providerEffectAssuranceCount: number;
    semanticVerdictCount: number;
  };
  proofDigests: {
    manifestSignatureSha256: string;
    manifestAuthorityPinsSha256: string;
    observerPinsSha256: string;
    semanticJudgePinsSha256: string;
    trajectoryInventorySha256: string;
    runnerResultSha256: string;
    observerEnvelopeSha256: string;
    observerProvenanceSha256: string;
    providerObservationsSha256: string;
    connectorBindingsSha256: string;
    failurePathObservationsSha256: string;
    stageReferencesSha256: string;
    readbackReplayAssurancesSha256: string;
    semanticEnvelopeSha256: string;
    semanticVerdictsSha256: string;
    decisionSha256: string;
  };
}

export interface ProviderQualificationReverificationCapsule {
  scenarioDefinition: ScenarioDefinition;
  manifest: ProviderQualificationManifest;
  manifestSignature: ProviderQualificationManifestSignature;
  publicKeyPins: {
    manifestAuthorities: readonly [
      ProviderQualificationPublicKeyPin,
      ...ProviderQualificationPublicKeyPin[],
    ];
    providerObservers: readonly [
      ProviderQualificationPublicKeyPin,
      ...ProviderQualificationPublicKeyPin[],
    ];
    semanticJudges: readonly [
      ProviderQualificationPublicKeyPin,
      ...ProviderQualificationPublicKeyPin[],
    ];
  };
  signedObserverEvidence: SignedProviderObserverEvidence;
  signedSemanticJudgeEvidence: SignedSemanticJudgeEvidence;
  trajectoryInventory: PortableVerifiedScenarioTrajectorySet;
  runnerResult: ProviderRunnerResultProjection;
  verifierTranscript: ProviderQualificationVerifierTranscript;
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
  reverification: ProviderQualificationReverificationCapsule;
  qualifiedReport?: ProviderQualifiedReportProjection;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function snapshot<T>(value: T, valuePath: string): T {
  return canonicalJsonValue(value, valuePath) as T;
}

function exactKeys(
  value: unknown,
  valuePath: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${valuePath} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(record, key));
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${valuePath} violates the closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
  return record;
}

function validateHash(value: unknown, valuePath: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${valuePath} must be a lowercase SHA-256 digest`);
  }
  return value;
}

/** Convert a trusted key file into a public-only canonical SPKI pin. */
export function normalizeProviderQualificationPublicKeyPins(
  values: readonly [string, ...string[]],
  valuePath: string,
): [ProviderQualificationPublicKeyPin, ...ProviderQualificationPublicKeyPin[]] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 16) {
    throw new Error(`${valuePath} must contain 1-16 public keys`);
  }
  const seen = new Set<string>();
  return values.map((pem, index) => {
    if (
      typeof pem !== "string" ||
      pem.length > 32_768 ||
      !pem.includes("-----BEGIN PUBLIC KEY-----") ||
      pem.includes("PRIVATE KEY")
    ) {
      throw new Error(`${valuePath}[${index}] must be a public SPKI PEM`);
    }
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(pem);
    } catch (error) {
      // error-policy:J2 preserve public-key parse failures at the capsule boundary.
      throw new Error(`${valuePath}[${index}] is not a valid public key`, {
        cause: error,
      });
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error(`${valuePath}[${index}] must be an Ed25519 public key`);
    }
    const spkiPem = publicKey.export({ type: "spki", format: "pem" });
    const keyId = providerObserverKeyId(spkiPem);
    if (seen.has(keyId)) {
      throw new Error(`${valuePath}[${index}] duplicates an earlier key`);
    }
    seen.add(keyId);
    return { keyId, algorithm: "ed25519", spkiPem };
  }) as [
    ProviderQualificationPublicKeyPin,
    ...ProviderQualificationPublicKeyPin[],
  ];
}

function publicKeyPem(
  pins: readonly [
    ProviderQualificationPublicKeyPin,
    ...ProviderQualificationPublicKeyPin[],
  ],
  valuePath: string,
): [string, ...string[]] {
  const normalized = normalizeProviderQualificationPublicKeyPins(
    pins.map((pin, index) => {
      const record = exactKeys(pin, `${valuePath}[${index}]`, [
        "keyId",
        "algorithm",
        "spkiPem",
      ]);
      if (record.algorithm !== "ed25519") {
        throw new Error(`${valuePath}[${index}].algorithm is unsupported`);
      }
      return record.spkiPem as string;
    }) as [string, ...string[]],
    valuePath,
  );
  for (const [index, pin] of pins.entries()) {
    if (normalized[index]?.keyId !== pin.keyId) {
      throw new Error(`${valuePath}[${index}].keyId does not match its SPKI`);
    }
  }
  return normalized.map((pin) => pin.spkiPem) as [string, ...string[]];
}

function portableTrajectories(
  trajectories: VerifiedScenarioTrajectorySet,
): PortableVerifiedScenarioTrajectorySet {
  return snapshot(
    {
      runId: trajectories.runId,
      scenarioId: trajectories.scenarioId,
      scenarioStartedAtIso: trajectories.scenarioStartedAtIso,
      scenarioEndedAtIso: trajectories.scenarioEndedAtIso,
      verifiedAtIso: trajectories.verifiedAtIso,
      setSha256: trajectories.setSha256,
      trajectories: trajectories.trajectories,
    },
    "trajectoryInventory",
  );
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

function transcript(input: {
  nowIso: string;
  maxSignatureAgeMs?: number;
  maxClockSkewMs?: number;
  manifestSignature: ProviderQualificationManifestSignature;
  pins: ProviderQualificationReverificationCapsule["publicKeyPins"];
  trajectories: PortableVerifiedScenarioTrajectorySet;
  runnerResult: ProviderRunnerResultProjection;
  signedEvidence: SignedProviderObserverEvidence;
  signedSemanticEvidence: SignedSemanticJudgeEvidence;
  decision: ProviderQualificationDecision;
}): ProviderQualificationVerifierTranscript {
  const observationPayload = input.signedEvidence.payload;
  return snapshot(
    {
      schema: PROVIDER_QUALIFICATION_VERIFIER_TRANSCRIPT_SCHEMA,
      implementation: "@elizaos/scenario-runner/provider-qualification",
      verifiedAtIso: input.nowIso,
      verificationOptions: {
        ...(input.maxSignatureAgeMs === undefined
          ? {}
          : { maxSignatureAgeMs: input.maxSignatureAgeMs }),
        ...(input.maxClockSkewMs === undefined
          ? {}
          : { maxClockSkewMs: input.maxClockSkewMs }),
      },
      sourcePrivacy: {
        privateProviderTargetsRetained: false,
        privateKeysRetained: false,
        credentialsRetained: false,
        rawRunnerTranscriptRetained: false,
        runDirectoryPathRetained: false,
      },
      inventory: {
        trajectoryCount: input.trajectories.trajectories.length,
        trajectoryStageCount: input.trajectories.trajectories.reduce(
          (count, trajectory) => count + trajectory.stages.length,
          0,
        ),
        runnerFinalCheckCount: input.runnerResult.finalChecks.length,
        observationCount: observationPayload.observations.length,
        failureProbeObservationCount:
          observationPayload.failureProbeObservations.length,
        providerEffectAssuranceCount:
          observationPayload.providerEffectAssurances.length,
        semanticVerdictCount:
          input.signedSemanticEvidence.payload.verdicts.length,
      },
      proofDigests: {
        manifestSignatureSha256: canonicalSha256(
          input.manifestSignature,
          "manifestSignature",
        ),
        manifestAuthorityPinsSha256: canonicalSha256(
          input.pins.manifestAuthorities,
          "manifestAuthorityPins",
        ),
        observerPinsSha256: canonicalSha256(
          input.pins.providerObservers,
          "providerObserverPins",
        ),
        semanticJudgePinsSha256: canonicalSha256(
          input.pins.semanticJudges,
          "semanticJudgePins",
        ),
        trajectoryInventorySha256: canonicalSha256(
          input.trajectories,
          "trajectoryInventory",
        ),
        runnerResultSha256: input.runnerResult.runnerResultSha256,
        observerEnvelopeSha256: canonicalSha256(
          input.signedEvidence,
          "signedObserverEvidence",
        ),
        observerProvenanceSha256: canonicalSha256(
          observationPayload.observerProvenance,
          "observerProvenance",
        ),
        providerObservationsSha256: canonicalSha256(
          observationPayload.observations,
          "providerObservations",
        ),
        connectorBindingsSha256: canonicalSha256(
          observationPayload.connectorBindings,
          "connectorBindings",
        ),
        failurePathObservationsSha256: canonicalSha256(
          observationPayload.failureProbeObservations,
          "failurePathObservations",
        ),
        stageReferencesSha256: canonicalSha256(
          observationPayload.stageReferences,
          "stageReferences",
        ),
        readbackReplayAssurancesSha256: canonicalSha256(
          observationPayload.providerEffectAssurances,
          "readbackReplayAssurances",
        ),
        semanticEnvelopeSha256: canonicalSha256(
          input.signedSemanticEvidence,
          "signedSemanticEvidence",
        ),
        semanticVerdictsSha256: canonicalSha256(
          input.signedSemanticEvidence.payload.verdicts,
          "semanticVerdicts",
        ),
        decisionSha256: canonicalSha256(input.decision, "decision"),
      },
    },
    "verifierTranscript",
  );
}

function qualifiedReportProjection(input: {
  decision: ProviderQualificationDecision;
  scenarioId: string;
  runnerResultSha256: string;
  trajectorySetSha256: string;
  observerEvidenceSha256: string;
  semanticEvidenceSha256: string;
}): ProviderQualifiedReportProjection | undefined {
  if (!input.decision.qualification.publishable) return undefined;
  if (
    !input.decision.guarantees.providerAuthorizationVerified ||
    !input.decision.guarantees.providerFailurePathsVerified ||
    !input.decision.guarantees.providerAcceptanceVerified ||
    !input.decision.guarantees.providerReadbackVerified ||
    !input.decision.guarantees.providerIdempotencyVerified
  ) {
    throw new Error(
      "publishable provider qualification lacks an authorization, failure-path, acceptance, readback, or idempotency guarantee",
    );
  }
  return snapshot(
    {
      scenarioId: input.scenarioId,
      status: "passed",
      executionProfile: "provider-qualified",
      evidenceScope: "provider-certification",
      qualification: input.decision.qualification,
      runnerResultSha256: input.runnerResultSha256,
      trajectorySetSha256: input.trajectorySetSha256,
      observerEvidenceSha256: input.observerEvidenceSha256,
      semanticEvidenceSha256: input.semanticEvidenceSha256,
    },
    "qualifiedReportProjection",
  );
}

function compareCanonical(left: unknown, right: unknown, label: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new Error(
      `provider qualification artifact ${label} does not reverify`,
    );
  }
}

/**
 * Re-run the exact qualification decision from only the persisted public
 * capsule. No provider access, private input, run directory, or transcript is
 * needed; filesystem verification is represented by its signed inventory.
 */
export function reverifyProviderQualificationArtifact(
  value: unknown,
): ProviderQualificationDecision {
  const artifact = validateProviderQualificationArtifact(value);
  const capsule = artifact.reverification;
  const authorityKeys = publicKeyPem(
    capsule.publicKeyPins.manifestAuthorities,
    "reverification.publicKeyPins.manifestAuthorities",
  );
  const observerKeys = publicKeyPem(
    capsule.publicKeyPins.providerObservers,
    "reverification.publicKeyPins.providerObservers",
  );
  const semanticKeys = publicKeyPem(
    capsule.publicKeyPins.semanticJudges,
    "reverification.publicKeyPins.semanticJudges",
  );
  const trajectories: VerifiedScenarioTrajectorySet = {
    ...capsule.trajectoryInventory,
    // The original absolute path is intentionally not evidence and is not
    // covered by setSha256. A normalized synthetic path satisfies the closed
    // in-memory verifier shape without pretending the raw files are present.
    runDirectoryRealPath: path.resolve(
      path.parse(process.cwd()).root,
      "provider-qualification-capsule",
      capsule.trajectoryInventory.runId,
    ),
  };
  const decision = deriveProviderQualification({
    scenarioDefinition: capsule.scenarioDefinition,
    manifest: capsule.manifest,
    manifestSignature: capsule.manifestSignature,
    pinnedManifestAuthorityPublicKeysPem: authorityKeys,
    trajectories,
    signedEvidence: capsule.signedObserverEvidence,
    pinnedObserverPublicKeysPem: observerKeys,
    signedSemanticEvidence: capsule.signedSemanticJudgeEvidence,
    pinnedSemanticJudgePublicKeysPem: semanticKeys,
    scenarioStatus: capsule.runnerResult.scenarioStatus,
    finalChecks: capsule.runnerResult.finalChecks,
    nowIso: capsule.verifierTranscript.verifiedAtIso,
    ...capsule.verifierTranscript.verificationOptions,
  });
  compareCanonical(decision, artifact.decision, "decision");
  const expectedTranscript = transcript({
    nowIso: capsule.verifierTranscript.verifiedAtIso,
    ...capsule.verifierTranscript.verificationOptions,
    manifestSignature: capsule.manifestSignature,
    pins: capsule.publicKeyPins,
    trajectories: capsule.trajectoryInventory,
    runnerResult: capsule.runnerResult,
    signedEvidence: capsule.signedObserverEvidence,
    signedSemanticEvidence: capsule.signedSemanticJudgeEvidence,
    decision,
  });
  compareCanonical(
    expectedTranscript,
    capsule.verifierTranscript,
    "verifier transcript",
  );
  const expectedReport = qualifiedReportProjection({
    decision,
    scenarioId: capsule.scenarioDefinition.id,
    runnerResultSha256: capsule.runnerResult.runnerResultSha256,
    trajectorySetSha256: capsule.trajectoryInventory.setSha256,
    observerEvidenceSha256:
      expectedTranscript.proofDigests.observerEnvelopeSha256,
    semanticEvidenceSha256:
      expectedTranscript.proofDigests.semanticEnvelopeSha256,
  });
  compareCanonical(
    expectedReport,
    artifact.qualifiedReport,
    "report projection",
  );
  if (
    artifact.scenarioId !== capsule.scenarioDefinition.id ||
    artifact.runId !== capsule.manifest.run.runId ||
    artifact.repositorySha !== capsule.manifest.run.repositorySha ||
    artifact.deploymentSha !== capsule.manifest.run.deploymentSha ||
    artifact.manifestSha256 !== capsule.manifest.manifestSha256 ||
    artifact.trajectorySetSha256 !== capsule.trajectoryInventory.setSha256 ||
    artifact.runnerResultSha256 !== capsule.runnerResult.runnerResultSha256 ||
    artifact.observerEvidenceSha256 !==
      expectedTranscript.proofDigests.observerEnvelopeSha256 ||
    artifact.semanticEvidenceSha256 !==
      expectedTranscript.proofDigests.semanticEnvelopeSha256
  ) {
    throw new Error(
      "provider qualification artifact top-level projection does not reverify",
    );
  }
  return decision;
}

/** Validate a persisted artifact before catalog rendering or offline replay. */
export function validateProviderQualificationArtifact(
  value: unknown,
): ProviderQualificationArtifact {
  const artifact = snapshot(
    value,
    "providerQualificationArtifact",
  ) as unknown as ProviderQualificationArtifact;
  const record = exactKeys(
    artifact,
    "provider qualification artifact",
    [
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
      "reverification",
    ],
    ["qualifiedReport"],
  );
  if (record.schema !== PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA) {
    throw new Error("provider qualification artifact schema is unsupported");
  }
  validateHash(record.artifactSha256, "artifactSha256");
  const { artifactSha256, ...core } = artifact;
  if (
    canonicalSha256(core, "providerQualificationArtifact") !== artifactSha256
  ) {
    throw new Error("provider qualification artifact digest does not match");
  }
  const capsule = exactKeys(artifact.reverification, "reverification", [
    "scenarioDefinition",
    "manifest",
    "manifestSignature",
    "publicKeyPins",
    "signedObserverEvidence",
    "signedSemanticJudgeEvidence",
    "trajectoryInventory",
    "runnerResult",
    "verifierTranscript",
  ]);
  const pins = exactKeys(
    capsule.publicKeyPins,
    "reverification.publicKeyPins",
    ["manifestAuthorities", "providerObservers", "semanticJudges"],
  );
  for (const key of [
    "manifestAuthorities",
    "providerObservers",
    "semanticJudges",
  ] as const) {
    if (!Array.isArray(pins[key]) || pins[key].length === 0) {
      throw new Error(`reverification.publicKeyPins.${key} must be non-empty`);
    }
  }
  const transcriptRecord = exactKeys(
    capsule.verifierTranscript,
    "reverification.verifierTranscript",
    [
      "schema",
      "implementation",
      "verifiedAtIso",
      "verificationOptions",
      "sourcePrivacy",
      "inventory",
      "proofDigests",
    ],
  );
  if (
    transcriptRecord.schema !==
      PROVIDER_QUALIFICATION_VERIFIER_TRANSCRIPT_SCHEMA ||
    transcriptRecord.implementation !==
      "@elizaos/scenario-runner/provider-qualification"
  ) {
    throw new Error(
      "provider qualification verifier transcript is unsupported",
    );
  }
  if (
    artifact.decision.manifestSha256 !== artifact.manifestSha256 ||
    artifact.reverification.manifest.manifestSha256 !==
      artifact.manifestSha256 ||
    artifact.reverification.trajectoryInventory.setSha256 !==
      artifact.trajectorySetSha256 ||
    artifact.reverification.runnerResult.runnerResultSha256 !==
      artifact.runnerResultSha256 ||
    artifact.reverification.signedObserverEvidence.payload
      .runnerResultSha256 !== artifact.runnerResultSha256 ||
    (artifact.decision.qualification.publishable &&
      artifact.qualifiedReport === undefined) ||
    (!artifact.decision.qualification.publishable &&
      artifact.qualifiedReport !== undefined)
  ) {
    throw new Error("provider qualification artifact decision is inconsistent");
  }
  return artifact;
}

/**
 * Recompute a qualification decision and its portable evidence capsule. An
 * unqualified decision is retained for diagnostics but never gains a
 * `qualifiedReport`, so callers cannot publish runner-authored assertions.
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
  const runnerResult: ProviderRunnerResultProjection = snapshot(
    {
      scenarioStatus: input.runnerReport.status,
      finalChecks,
      runnerResultSha256: runnerResultSha256({
        scenarioStatus: input.runnerReport.status,
        finalChecks,
      }),
    },
    "runnerResult",
  );
  const manifestAuthorities = normalizeProviderQualificationPublicKeyPins(
    input.pinnedManifestAuthorityPublicKeysPem,
    "pinnedManifestAuthorityPublicKeysPem",
  );
  const providerObservers = normalizeProviderQualificationPublicKeyPins(
    input.pinnedObserverPublicKeysPem,
    "pinnedObserverPublicKeysPem",
  );
  const semanticJudges = normalizeProviderQualificationPublicKeyPins(
    input.pinnedSemanticJudgePublicKeysPem,
    "pinnedSemanticJudgePublicKeysPem",
  );
  const decision = deriveProviderQualification({
    scenarioDefinition: input.scenarioDefinition,
    manifest: input.manifest,
    manifestSignature: input.manifestSignature,
    pinnedManifestAuthorityPublicKeysPem: manifestAuthorities.map(
      (pin) => pin.spkiPem,
    ) as [string, ...string[]],
    trajectories: input.trajectories,
    signedEvidence: input.signedEvidence,
    pinnedObserverPublicKeysPem: providerObservers.map(
      (pin) => pin.spkiPem,
    ) as [string, ...string[]],
    signedSemanticEvidence: input.signedSemanticEvidence,
    pinnedSemanticJudgePublicKeysPem: semanticJudges.map(
      (pin) => pin.spkiPem,
    ) as [string, ...string[]],
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
  const trajectoryInventory = portableTrajectories(input.trajectories);
  const publicKeyPins = {
    manifestAuthorities,
    providerObservers,
    semanticJudges,
  } as const;
  const verifierTranscript = transcript({
    nowIso: input.nowIso,
    ...(input.maxSignatureAgeMs === undefined
      ? {}
      : { maxSignatureAgeMs: input.maxSignatureAgeMs }),
    ...(input.maxClockSkewMs === undefined
      ? {}
      : { maxClockSkewMs: input.maxClockSkewMs }),
    manifestSignature: input.manifestSignature,
    pins: publicKeyPins,
    trajectories: trajectoryInventory,
    runnerResult,
    signedEvidence: input.signedEvidence,
    signedSemanticEvidence: input.signedSemanticEvidence,
    decision,
  });
  const observerEvidenceSha256 =
    verifierTranscript.proofDigests.observerEnvelopeSha256;
  const semanticEvidenceSha256 =
    verifierTranscript.proofDigests.semanticEnvelopeSha256;
  const report = qualifiedReportProjection({
    decision,
    scenarioId: input.scenarioDefinition.id,
    runnerResultSha256: runnerResult.runnerResultSha256,
    trajectorySetSha256: input.trajectories.setSha256,
    observerEvidenceSha256,
    semanticEvidenceSha256,
  });
  const core = {
    schema: PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA,
    createdAtIso: input.nowIso,
    scenarioId: input.scenarioDefinition.id,
    runId: input.manifest.run.runId,
    repositorySha: input.manifest.run.repositorySha,
    deploymentSha: input.manifest.run.deploymentSha,
    manifestSha256: input.manifest.manifestSha256,
    trajectorySetSha256: input.trajectories.setSha256,
    runnerResultSha256: runnerResult.runnerResultSha256,
    observerEvidenceSha256,
    semanticEvidenceSha256,
    decision,
    reverification: {
      scenarioDefinition: input.scenarioDefinition,
      manifest: input.manifest,
      manifestSignature: input.manifestSignature,
      publicKeyPins,
      signedObserverEvidence: input.signedEvidence,
      signedSemanticJudgeEvidence: input.signedSemanticEvidence,
      trajectoryInventory,
      runnerResult,
      verifierTranscript,
    },
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
