/**
 * Derives publication eligibility from an operator-signed manifest, signed
 * external-observer payload, and locally verified trajectories. Caller-authored
 * qualification labels are not accepted: every signer, observation, stage
 * reference, semantic verdict, and provider assurance is recomputed.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import type {
  ScenarioEvidenceObservation,
  ScenarioEvidenceObserverProvenance,
  ScenarioEvidenceQualification,
} from "../types.ts";
import {
  type CanonicalJsonValue,
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
  type ProviderObservationContract,
  type ProviderQualificationManifest,
  validateProviderQualificationManifestForScenario,
} from "./manifest.ts";
import {
  type ProviderOperationBinding,
  validateProviderOperationBinding,
} from "./operation-binding.ts";
import {
  type VerifiedScenarioTrajectorySet,
  validateVerifiedScenarioTrajectorySet,
} from "./trajectory-verifier.ts";

export const PROVIDER_OBSERVER_EVIDENCE_SCHEMA =
  "eliza.provider-qualified-observer-evidence.v2" as const;
export const SEMANTIC_JUDGE_EVIDENCE_SCHEMA =
  "eliza.provider-qualified-semantic-evidence.v1" as const;

export interface SignedStageReference {
  observationId: string;
  trajectoryId: string;
  stageId: string;
  stageSha256: string;
}

export interface ProviderEffectAssurance {
  observationId: string;
  providerAccepted: boolean;
  readbackVerified: boolean;
  idempotency:
    | {
        mode: "unsupported";
        replayVerified: false;
      }
    | {
        mode: "provider-key" | "provider-readback";
        keySha256: string;
        replayVerified: boolean;
      };
}

export interface SignedObservationConnectorBinding {
  observationId: string;
  provider: string;
  accountRefSha256: string;
  connectionRefSha256: string;
  operation: ProviderOperationBinding;
}

export interface ProviderObserverEvidencePayload {
  schema: typeof PROVIDER_OBSERVER_EVIDENCE_SCHEMA;
  manifestSha256: string;
  runId: string;
  runNonce: string;
  scenarioId: string;
  scenarioStartedAtIso: string;
  scenarioEndedAtIso: string;
  trajectoryVerifiedAtIso: string;
  signedAtIso: string;
  trajectorySetSha256: string;
  runnerResultSha256: string;
  observerProvenance: readonly ScenarioEvidenceObserverProvenance[];
  observations: readonly ScenarioEvidenceObservation[];
  connectorBindings: readonly SignedObservationConnectorBinding[];
  stageReferences: readonly SignedStageReference[];
  providerEffectAssurances: readonly ProviderEffectAssurance[];
}

export interface SignedProviderObserverEvidence {
  keyId: string;
  payload: ProviderObserverEvidencePayload;
  signature: string;
}

export interface LocalFinalCheckResult {
  definitionSha256: string;
  status: "passed" | "failed" | "skipped" | "unknown";
}

export interface SemanticCriterionVerdict {
  criterionId: string;
  rubricSha256: string;
  status: "passed" | "failed" | "unknown";
  score: number;
  requestSha256: string;
  responseSha256: string;
}

export interface SemanticJudgeEvidencePayload {
  schema: typeof SEMANTIC_JUDGE_EVIDENCE_SCHEMA;
  manifestSha256: string;
  runId: string;
  runNonce: string;
  scenarioId: string;
  scenarioEndedAtIso: string;
  trajectoryVerifiedAtIso: string;
  signedAtIso: string;
  trajectorySetSha256: string;
  actingAdapter: string;
  actingProvider: string;
  actingModel: string;
  judgeProvider: string;
  judgeModel: string;
  verdicts: readonly SemanticCriterionVerdict[];
}

export interface SignedSemanticJudgeEvidence {
  keyId: string;
  payload: SemanticJudgeEvidencePayload;
  signature: string;
}

export interface ProviderQualificationManifestSignature {
  keyId: string;
  manifestSha256: string;
  signature: string;
}

export interface ProviderQualificationDecision {
  manifestSha256: string;
  qualification: Exclude<
    ScenarioEvidenceQualification,
    { status: "ineligible" }
  >;
  matchedObservationContracts: readonly {
    observationId: string;
    contractId: string;
  }[];
  guarantees: {
    providerAcceptanceVerified: boolean;
    providerReadbackVerified: boolean;
    providerIdempotencyVerified: boolean;
    exactlyOnce: false;
  };
}

export interface DeriveProviderQualificationInput {
  scenarioDefinition: ScenarioDefinition;
  manifest: ProviderQualificationManifest;
  manifestSignature: ProviderQualificationManifestSignature;
  /** Trusted operator configuration, never a key list supplied by the run. */
  pinnedManifestAuthorityPublicKeysPem: readonly [string, ...string[]];
  trajectories: VerifiedScenarioTrajectorySet;
  signedEvidence: SignedProviderObserverEvidence;
  pinnedObserverPublicKeysPem: readonly [string, ...string[]];
  signedSemanticEvidence: SignedSemanticJudgeEvidence;
  pinnedSemanticJudgePublicKeysPem: readonly [string, ...string[]];
  scenarioStatus: "passed" | "failed" | "skipped";
  finalChecks: readonly LocalFinalCheckResult[];
  nowIso: string;
  maxSignatureAgeMs?: number;
  maxClockSkewMs?: number;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_SIGNATURE_AGE_MS = 5 * 60_000;
const DEFAULT_MAX_CLOCK_SKEW_MS = 5_000;
const MAX_PINNED_KEYS = 16;
const MAX_OBSERVER_PROVENANCE = 64;
const MAX_OBSERVATIONS = 256;
const MAX_CONNECTOR_BINDINGS = 256;
const MAX_STAGE_REFERENCES = 2_048;
const MAX_PROVIDER_ASSURANCES = 256;
const MAX_TRAJECTORY_REFS_PER_OBSERVATION = 64;
const MAX_EFFECT_KINDS = 64;
const MAX_SEMANTIC_VERDICTS = 128;
const MAX_FINAL_CHECK_RESULTS = 512;
const MAX_SIGNED_PAYLOAD_BYTES = 2 * 1024 * 1024;
const PAYLOAD_KEYS = [
  "schema",
  "manifestSha256",
  "runId",
  "runNonce",
  "scenarioId",
  "scenarioStartedAtIso",
  "scenarioEndedAtIso",
  "trajectoryVerifiedAtIso",
  "signedAtIso",
  "trajectorySetSha256",
  "runnerResultSha256",
  "observerProvenance",
  "observations",
  "connectorBindings",
  "stageReferences",
  "providerEffectAssurances",
] as const;
const SEMANTIC_PAYLOAD_KEYS = [
  "schema",
  "manifestSha256",
  "runId",
  "runNonce",
  "scenarioId",
  "scenarioEndedAtIso",
  "trajectoryVerifiedAtIso",
  "signedAtIso",
  "trajectorySetSha256",
  "actingAdapter",
  "actingProvider",
  "actingModel",
  "judgeProvider",
  "judgeModel",
  "verdicts",
] as const;

function requireExactKeys(
  value: object,
  path: string,
  keys: readonly string[],
  optional: readonly string[] = [],
): void {
  const record = value as Record<string, unknown>;
  const expected = new Set([...keys, ...optional]);
  const missing = keys.filter((key) => !Object.hasOwn(record, key));
  const unknown = Object.keys(record).filter((key) => !expected.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${path} violates the closed protocol (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
}

function runtimeRecord(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function inputDataProperty(
  input: Record<string, unknown>,
  key: string,
  required = true,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) {
    if (required) {
      throw new Error(`qualification input.${key} is required`);
    }
    return undefined;
  }
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new Error(
      `qualification input.${key} must be an enumerable data property`,
    );
  }
  return descriptor.value;
}

function runtimeArray(
  value: unknown,
  path: string,
  maximumLength: number,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  if (value.length > maximumLength) {
    throw new Error(`${path} cannot exceed ${maximumLength} items`);
  }
  return value;
}

function runtimeString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  if (value.length > 16_384) {
    throw new Error(`${path} exceeds the protocol string limit`);
  }
  return value;
}

function runtimeHash(value: unknown, path: string): string {
  const hash = runtimeString(value, path);
  if (!SHA256_PATTERN.test(hash)) {
    throw new Error(`${path} must be a lowercase SHA-256 digest`);
  }
  return hash;
}

function runtimeTimestamp(value: unknown, path: string): string {
  const iso = runtimeString(value, path);
  timestamp(iso, path);
  return iso;
}

function validateSource(value: unknown, path: string): void {
  const source = runtimeRecord(value, path);
  requireExactKeys(
    source,
    path,
    ["kind", "system", "environment", "recordIdSha256"],
    ["accountRefSha256"],
  );
  if (
    ![
      "provider-api",
      "provider-webhook",
      "durable-database",
      "scheduler-runner",
    ].includes(runtimeString(source.kind, `${path}.kind`))
  ) {
    throw new Error(`${path}.kind is unsupported`);
  }
  runtimeString(source.system, `${path}.system`);
  runtimeString(source.environment, `${path}.environment`);
  runtimeHash(source.recordIdSha256, `${path}.recordIdSha256`);
  if (source.accountRefSha256 !== undefined) {
    runtimeHash(source.accountRefSha256, `${path}.accountRefSha256`);
  }
}

function validateTrajectoryRefs(value: unknown, path: string): void {
  const references = runtimeArray(
    value,
    path,
    MAX_TRAJECTORY_REFS_PER_OBSERVATION,
  );
  if (references.length === 0) {
    throw new Error(`${path} must be non-empty`);
  }
  for (const [index, item] of references.entries()) {
    const itemPath = `${path}[${index}]`;
    const reference = runtimeRecord(item, itemPath);
    requireExactKeys(reference, itemPath, [
      "trajectoryId",
      "stageId",
      "sha256",
    ]);
    runtimeString(reference.trajectoryId, `${itemPath}.trajectoryId`);
    runtimeString(reference.stageId, `${itemPath}.stageId`);
    runtimeHash(reference.sha256, `${itemPath}.sha256`);
  }
}

function validateObservation(value: unknown, path: string): string {
  const observation = runtimeRecord(value, path);
  const common = [
    "observationId",
    "kind",
    "observedAtIso",
    "observerId",
    "source",
    "payloadSha256",
    "trajectoryRefs",
  ];
  const kind = runtimeString(observation.kind, `${path}.kind`);
  const fields: Record<string, { required: string[]; optional?: string[] }> = {
    "durable-approval": {
      required: [
        "approvalIdSha256",
        "actionName",
        "state",
        "requestPayloadSha256",
      ],
      optional: ["decisionPayloadSha256"],
    },
    "durable-draft": {
      required: [
        "draftIdSha256",
        "channel",
        "state",
        "recipientSetSha256",
        "contentSha256",
      ],
    },
    "provider-effect": {
      required: [
        "provider",
        "operation",
        "accountRefSha256",
        "requestSha256",
        "responseSha256",
        "providerReceiptIdSha256",
      ],
      optional: ["readbackSha256"],
    },
    "provider-no-effect": {
      required: [
        "provider",
        "accountRefSha256",
        "effectKinds",
        "scopeSha256",
        "beforeSnapshotSha256",
        "afterSnapshotSha256",
        "observationStartedAtIso",
        "observationEndedAtIso",
      ],
    },
    "scheduled-task": {
      required: ["taskIdSha256", "scheduleSha256", "state", "scheduledForIso"],
      optional: [
        "executionIdSha256",
        "resultSha256",
        "providerReceiptIdSha256",
      ],
    },
  };
  const shape = fields[kind];
  if (!shape) {
    throw new Error(`${path}.kind is unsupported`);
  }
  requireExactKeys(
    observation,
    path,
    [...common, ...shape.required],
    shape.optional,
  );
  const observationId = runtimeString(
    observation.observationId,
    `${path}.observationId`,
  );
  runtimeTimestamp(observation.observedAtIso, `${path}.observedAtIso`);
  runtimeString(observation.observerId, `${path}.observerId`);
  validateSource(observation.source, `${path}.source`);
  runtimeHash(observation.payloadSha256, `${path}.payloadSha256`);
  validateTrajectoryRefs(observation.trajectoryRefs, `${path}.trajectoryRefs`);
  for (const [key, fieldValue] of Object.entries(observation)) {
    if (
      key.endsWith("Sha256") &&
      key !== "accountRefSha256" &&
      fieldValue !== undefined
    ) {
      runtimeHash(fieldValue, `${path}.${key}`);
    }
  }
  if (observation.accountRefSha256 !== undefined) {
    runtimeHash(observation.accountRefSha256, `${path}.accountRefSha256`);
  }
  for (const key of [
    "provider",
    "operation",
    "actionName",
    "state",
    "channel",
  ]) {
    if (observation[key] !== undefined) {
      runtimeString(observation[key], `${path}.${key}`);
    }
  }
  if (kind === "provider-no-effect") {
    const effects = runtimeArray(
      observation.effectKinds,
      `${path}.effectKinds`,
      MAX_EFFECT_KINDS,
    );
    if (effects.length === 0) {
      throw new Error(`${path}.effectKinds must be non-empty`);
    }
    for (const [index, effect] of effects.entries()) {
      runtimeString(effect, `${path}.effectKinds[${index}]`);
    }
    runtimeTimestamp(
      observation.observationStartedAtIso,
      `${path}.observationStartedAtIso`,
    );
    runtimeTimestamp(
      observation.observationEndedAtIso,
      `${path}.observationEndedAtIso`,
    );
  }
  if (kind === "scheduled-task") {
    runtimeTimestamp(observation.scheduledForIso, `${path}.scheduledForIso`);
  }
  return observationId;
}

function parseSignedEvidenceRuntime(
  value: unknown,
): SignedProviderObserverEvidence {
  const snapshot = canonicalJsonValue(
    value,
    "signedEvidence",
  ) as unknown as SignedProviderObserverEvidence;
  if (
    Buffer.byteLength(
      canonicalJson(snapshot as unknown as CanonicalJsonValue),
      "utf8",
    ) > MAX_SIGNED_PAYLOAD_BYTES
  ) {
    throw new Error(
      `signedEvidence cannot exceed ${MAX_SIGNED_PAYLOAD_BYTES} bytes`,
    );
  }
  const envelope = runtimeRecord(snapshot, "signedEvidence");
  requireExactKeys(envelope, "signedEvidence", [
    "keyId",
    "payload",
    "signature",
  ]);
  runtimeHash(envelope.keyId, "signedEvidence.keyId");
  runtimeString(envelope.signature, "signedEvidence.signature");
  const payload = runtimeRecord(envelope.payload, "signedEvidence.payload");
  requireExactKeys(payload, "signedEvidence.payload", PAYLOAD_KEYS);
  if (payload.schema !== PROVIDER_OBSERVER_EVIDENCE_SCHEMA) {
    throw new Error("signedEvidence.payload.schema is unsupported");
  }
  for (const key of [
    "manifestSha256",
    "trajectorySetSha256",
    "runnerResultSha256",
  ] as const) {
    runtimeHash(payload[key], `signedEvidence.payload.${key}`);
  }
  for (const key of ["runId", "runNonce", "scenarioId"] as const) {
    runtimeString(payload[key], `signedEvidence.payload.${key}`);
  }
  for (const key of [
    "scenarioStartedAtIso",
    "scenarioEndedAtIso",
    "trajectoryVerifiedAtIso",
    "signedAtIso",
  ] as const) {
    runtimeTimestamp(payload[key], `signedEvidence.payload.${key}`);
  }

  const provenance = runtimeArray(
    payload.observerProvenance,
    "signedEvidence.payload.observerProvenance",
    MAX_OBSERVER_PROVENANCE,
  );
  for (const [index, value] of provenance.entries()) {
    const itemPath = `signedEvidence.payload.observerProvenance[${index}]`;
    const observer = runtimeRecord(value, itemPath);
    requireExactKeys(observer, itemPath, [
      "observerId",
      "kind",
      "implementation",
      "version",
      "environment",
      "configurationSha256",
    ]);
    for (const key of [
      "observerId",
      "implementation",
      "version",
      "environment",
    ] as const) {
      runtimeString(observer[key], `${itemPath}.${key}`);
    }
    if (
      ![
        "provider-api",
        "provider-webhook",
        "durable-database",
        "scheduler-runner",
      ].includes(runtimeString(observer.kind, `${itemPath}.kind`))
    ) {
      throw new Error(`${itemPath}.kind is unsupported`);
    }
    runtimeHash(
      observer.configurationSha256,
      `${itemPath}.configurationSha256`,
    );
  }

  const observations = runtimeArray(
    payload.observations,
    "signedEvidence.payload.observations",
    MAX_OBSERVATIONS,
  );
  const observationIds = new Set<string>();
  for (const [index, observation] of observations.entries()) {
    const observationId = validateObservation(
      observation,
      `signedEvidence.payload.observations[${index}]`,
    );
    if (observationIds.has(observationId)) {
      throw new Error("signedEvidence.payload.observations has duplicate IDs");
    }
    observationIds.add(observationId);
  }

  for (const key of ["connectorBindings", "stageReferences"] as const) {
    const values = runtimeArray(
      payload[key],
      `signedEvidence.payload.${key}`,
      key === "connectorBindings"
        ? MAX_CONNECTOR_BINDINGS
        : MAX_STAGE_REFERENCES,
    );
    const fields =
      key === "connectorBindings"
        ? [
            "observationId",
            "provider",
            "accountRefSha256",
            "connectionRefSha256",
            "operation",
          ]
        : ["observationId", "trajectoryId", "stageId", "stageSha256"];
    for (const [index, value] of values.entries()) {
      const itemPath = `signedEvidence.payload.${key}[${index}]`;
      const item = runtimeRecord(value, itemPath);
      requireExactKeys(item, itemPath, fields);
      for (const field of fields) {
        if (field === "operation") {
          validateProviderOperationBinding(item[field]);
          continue;
        }
        if (field.endsWith("Sha256")) {
          runtimeHash(item[field], `${itemPath}.${field}`);
        } else {
          runtimeString(item[field], `${itemPath}.${field}`);
        }
      }
    }
  }

  const assurances = runtimeArray(
    payload.providerEffectAssurances,
    "signedEvidence.payload.providerEffectAssurances",
    MAX_PROVIDER_ASSURANCES,
  );
  for (const [index, value] of assurances.entries()) {
    const itemPath = `signedEvidence.payload.providerEffectAssurances[${index}]`;
    const assurance = runtimeRecord(value, itemPath);
    requireExactKeys(assurance, itemPath, [
      "observationId",
      "providerAccepted",
      "readbackVerified",
      "idempotency",
    ]);
    runtimeString(assurance.observationId, `${itemPath}.observationId`);
    if (
      typeof assurance.providerAccepted !== "boolean" ||
      typeof assurance.readbackVerified !== "boolean"
    ) {
      throw new Error(`${itemPath} assurance flags must be boolean`);
    }
    const idempotency = runtimeRecord(
      assurance.idempotency,
      `${itemPath}.idempotency`,
    );
    const mode = runtimeString(
      idempotency.mode,
      `${itemPath}.idempotency.mode`,
    );
    requireExactKeys(
      idempotency,
      `${itemPath}.idempotency`,
      mode === "unsupported"
        ? ["mode", "replayVerified"]
        : ["mode", "keySha256", "replayVerified"],
    );
    if (
      !["unsupported", "provider-key", "provider-readback"].includes(mode) ||
      typeof idempotency.replayVerified !== "boolean"
    ) {
      throw new Error(`${itemPath}.idempotency is unsupported`);
    }
    if (mode === "unsupported" && idempotency.replayVerified !== false) {
      throw new Error(
        `${itemPath}.idempotency unsupported mode cannot claim replay verification`,
      );
    }
    if (mode !== "unsupported") {
      runtimeHash(idempotency.keySha256, `${itemPath}.idempotency.keySha256`);
    }
  }
  return snapshot;
}

function parseSemanticEvidenceRuntime(
  value: unknown,
): SignedSemanticJudgeEvidence {
  const snapshot = canonicalJsonValue(
    value,
    "signedSemanticEvidence",
  ) as unknown as SignedSemanticJudgeEvidence;
  if (
    Buffer.byteLength(
      canonicalJson(snapshot as unknown as CanonicalJsonValue),
      "utf8",
    ) > MAX_SIGNED_PAYLOAD_BYTES
  ) {
    throw new Error(
      `signedSemanticEvidence cannot exceed ${MAX_SIGNED_PAYLOAD_BYTES} bytes`,
    );
  }
  const envelope = runtimeRecord(snapshot, "signedSemanticEvidence");
  requireExactKeys(envelope, "signedSemanticEvidence", [
    "keyId",
    "payload",
    "signature",
  ]);
  runtimeHash(envelope.keyId, "signedSemanticEvidence.keyId");
  runtimeString(envelope.signature, "signedSemanticEvidence.signature");
  const payload = runtimeRecord(
    envelope.payload,
    "signedSemanticEvidence.payload",
  );
  requireExactKeys(
    payload,
    "signedSemanticEvidence.payload",
    SEMANTIC_PAYLOAD_KEYS,
  );
  if (payload.schema !== SEMANTIC_JUDGE_EVIDENCE_SCHEMA) {
    throw new Error("signedSemanticEvidence.payload.schema is unsupported");
  }
  for (const key of ["manifestSha256", "trajectorySetSha256"] as const) {
    runtimeHash(payload[key], `signedSemanticEvidence.payload.${key}`);
  }
  for (const key of [
    "runId",
    "runNonce",
    "scenarioId",
    "actingAdapter",
    "actingProvider",
    "actingModel",
    "judgeProvider",
    "judgeModel",
  ] as const) {
    runtimeString(payload[key], `signedSemanticEvidence.payload.${key}`);
  }
  for (const key of [
    "scenarioEndedAtIso",
    "trajectoryVerifiedAtIso",
    "signedAtIso",
  ] as const) {
    runtimeTimestamp(payload[key], `signedSemanticEvidence.payload.${key}`);
  }
  const verdicts = runtimeArray(
    payload.verdicts,
    "signedSemanticEvidence.payload.verdicts",
    MAX_SEMANTIC_VERDICTS,
  );
  for (const [index, value] of verdicts.entries()) {
    const path = `signedSemanticEvidence.payload.verdicts[${index}]`;
    const verdict = runtimeRecord(value, path);
    requireExactKeys(verdict, path, [
      "criterionId",
      "rubricSha256",
      "status",
      "score",
      "requestSha256",
      "responseSha256",
    ]);
    runtimeString(verdict.criterionId, `${path}.criterionId`);
    runtimeHash(verdict.rubricSha256, `${path}.rubricSha256`);
    runtimeHash(verdict.requestSha256, `${path}.requestSha256`);
    runtimeHash(verdict.responseSha256, `${path}.responseSha256`);
    if (!["passed", "failed", "unknown"].includes(String(verdict.status))) {
      throw new Error(`${path}.status is unsupported`);
    }
    if (
      typeof verdict.score !== "number" ||
      !Number.isFinite(verdict.score) ||
      verdict.score < 0 ||
      verdict.score > 1
    ) {
      throw new Error(`${path}.score must be between 0 and 1`);
    }
  }
  return snapshot;
}

function timestamp(value: string, path: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${path} must be an ISO-8601 timestamp`);
  }
  return parsed;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

/** SPKI fingerprint used to pin the observer that signed an evidence payload. */
export function providerObserverKeyId(publicKeyPem: string): string {
  if (!publicKeyPem.includes("-----BEGIN PUBLIC KEY-----")) {
    throw new Error("provider evidence pins must contain an SPKI public key");
  }
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("provider evidence keys must be Ed25519 public keys");
  }
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

/** Exact bytes an observer signs with Ed25519. */
export function providerEvidenceSigningBytes(
  payload: ProviderObserverEvidencePayload,
): Buffer {
  return Buffer.from(
    canonicalJson(canonicalJsonValue(payload, "providerEvidencePayload")),
    "utf8",
  );
}

/** Exact bytes an independent semantic judge signs with Ed25519. */
export function semanticEvidenceSigningBytes(
  payload: SemanticJudgeEvidencePayload,
): Buffer {
  return Buffer.from(
    canonicalJson(canonicalJsonValue(payload, "semanticEvidencePayload")),
    "utf8",
  );
}

/** Exact manifest bytes authorized by the operator before a run can qualify. */
export function providerManifestSigningBytes(
  manifest: ProviderQualificationManifest,
): Buffer {
  return Buffer.from(
    canonicalJson(
      canonicalJsonValue(manifest, "providerQualificationManifest"),
    ),
    "utf8",
  );
}

/** Digest signed by the provider observer after local checks have completed. */
export function runnerResultSha256(input: {
  scenarioStatus: "passed" | "failed" | "skipped";
  finalChecks: readonly LocalFinalCheckResult[];
}): string {
  const finalChecks = input.finalChecks
    .map((result) => ({
      definitionSha256: result.definitionSha256,
      status: result.status,
    }))
    .sort((left, right) => {
      const hashOrder = left.definitionSha256.localeCompare(
        right.definitionSha256,
      );
      return hashOrder !== 0
        ? hashOrder
        : left.status.localeCompare(right.status);
    });
  return canonicalSha256(
    { scenarioStatus: input.scenarioStatus, finalChecks },
    "runnerResult",
  );
}

function parseManifestRuntime(
  value: unknown,
  scenarioDefinition: ScenarioDefinition,
): ProviderQualificationManifest {
  return validateProviderQualificationManifestForScenario(
    value,
    scenarioDefinition,
  );
}

function parseManifestSignatureRuntime(
  value: unknown,
): ProviderQualificationManifestSignature {
  const snapshot = canonicalJsonValue(
    value,
    "manifestSignature",
  ) as unknown as ProviderQualificationManifestSignature;
  const signature = runtimeRecord(snapshot, "manifestSignature");
  requireExactKeys(signature, "manifestSignature", [
    "keyId",
    "manifestSha256",
    "signature",
  ]);
  runtimeHash(signature.keyId, "manifestSignature.keyId");
  runtimeHash(signature.manifestSha256, "manifestSignature.manifestSha256");
  runtimeString(signature.signature, "manifestSignature.signature");
  return snapshot;
}

function verifyManifestAuthority(
  signature: ProviderQualificationManifestSignature,
  manifest: ProviderQualificationManifest,
  pinnedKeys: readonly string[],
): boolean {
  if (
    signature.keyId !== manifest.trust.manifestAuthorityKeyId ||
    signature.manifestSha256 !== manifest.manifestSha256
  ) {
    return false;
  }
  const pinnedKey = pinnedKeys.find(
    (key) => providerObserverKeyId(key) === signature.keyId,
  );
  if (!pinnedKey) {
    return false;
  }
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature.signature, "base64url");
  } catch {
    // error-policy:J3 malformed external signature is an explicit invalid signal.
    return false;
  }
  return verifySignature(
    null,
    providerManifestSigningBytes(manifest),
    createPublicKey(pinnedKey),
    signatureBytes,
  );
}

function verifySignedEvidence(
  envelope: SignedProviderObserverEvidence,
  pinnedKeys: readonly string[],
  expectedKeyId: string,
): boolean {
  requireExactKeys(envelope, "signedEvidence", [
    "keyId",
    "payload",
    "signature",
  ]);
  requireExactKeys(envelope.payload, "signedEvidence.payload", PAYLOAD_KEYS);
  if (envelope.payload.schema !== PROVIDER_OBSERVER_EVIDENCE_SCHEMA) {
    return false;
  }
  if (envelope.keyId !== expectedKeyId) {
    return false;
  }
  const pinnedKey = pinnedKeys.find(
    (key) => providerObserverKeyId(key) === envelope.keyId,
  );
  if (!pinnedKey) {
    return false;
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(envelope.signature, "base64url");
  } catch {
    // error-policy:J3 malformed external signature is an explicit invalid signal.
    return false;
  }
  return verifySignature(
    null,
    providerEvidenceSigningBytes(envelope.payload),
    createPublicKey(pinnedKey),
    signature,
  );
}

function verifySignedSemanticEvidence(
  envelope: SignedSemanticJudgeEvidence,
  pinnedKeys: readonly string[],
  expectedKeyId: string,
): boolean {
  if (envelope.keyId !== expectedKeyId) {
    return false;
  }
  const pinnedKey = pinnedKeys.find(
    (key) => providerObserverKeyId(key) === envelope.keyId,
  );
  if (!pinnedKey) {
    return false;
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(envelope.signature, "base64url");
  } catch {
    // error-policy:J3 malformed external signature is an explicit invalid signal.
    return false;
  }
  return verifySignature(
    null,
    semanticEvidenceSigningBytes(envelope.payload),
    createPublicKey(pinnedKey),
    signature,
  );
}

function observationAccountHashes(
  observation: ScenarioEvidenceObservation,
): string[] {
  const values = [
    observation.source.accountRefSha256,
    "accountRefSha256" in observation
      ? observation.accountRefSha256
      : undefined,
  ];
  return values.filter((value): value is string => typeof value === "string");
}

function observationResourceHashes(
  observation: ScenarioEvidenceObservation,
): string[] {
  const values: Array<string | undefined> = [observation.source.recordIdSha256];
  if (observation.kind === "durable-approval") {
    values.push(observation.approvalIdSha256);
  } else if (observation.kind === "durable-draft") {
    values.push(observation.draftIdSha256);
  } else if (observation.kind === "provider-effect") {
    values.push(observation.providerReceiptIdSha256);
  } else if (observation.kind === "provider-no-effect") {
    values.push(observation.scopeSha256);
  } else {
    values.push(observation.taskIdSha256);
  }
  return values.filter((value): value is string => typeof value === "string");
}

function observationOperation(
  observation: ScenarioEvidenceObservation,
): string | undefined {
  if (observation.kind === "provider-effect") {
    return observation.operation;
  }
  if (observation.kind === "durable-approval") {
    return observation.actionName;
  }
  return undefined;
}

function observationState(
  observation: ScenarioEvidenceObservation,
): string | undefined {
  return "state" in observation ? observation.state : undefined;
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function matchesContract(
  observation: ScenarioEvidenceObservation,
  contract: ProviderObservationContract,
): boolean {
  if (
    observation.kind !== contract.kind ||
    observation.observerId !== contract.observerId ||
    observation.source.kind !== contract.sourceKind ||
    observation.source.system !== contract.system ||
    observation.source.environment !== contract.environment ||
    !observationAccountHashes(observation).includes(contract.accountRefSha256)
  ) {
    return false;
  }
  if (
    contract.resourceRefSha256 &&
    !observationResourceHashes(observation).includes(contract.resourceRefSha256)
  ) {
    return false;
  }
  if (
    (contract.kind === "provider-effect" ||
      contract.kind === "durable-approval") &&
    observationOperation(observation) !== contract.operation
  ) {
    return false;
  }
  if (
    (contract.kind === "durable-approval" ||
      contract.kind === "durable-draft" ||
      contract.kind === "scheduled-task") &&
    observationState(observation) !== contract.state
  ) {
    return false;
  }
  if (contract.kind === "provider-effect") {
    return (
      observation.kind === "provider-effect" &&
      observation.provider === contract.provider
    );
  }
  if (contract.kind === "provider-no-effect") {
    return (
      observation.kind === "provider-no-effect" &&
      observation.provider === contract.provider &&
      observation.scopeSha256 === contract.scopeSha256 &&
      sameStringSet(observation.effectKinds, contract.effectKinds)
    );
  }
  return true;
}

type ObservationAssignment = {
  observation: ScenarioEvidenceObservation;
  contract: ProviderObservationContract;
};

function exactObservationAssignment(
  observations: readonly ScenarioEvidenceObservation[],
  contracts: readonly ProviderObservationContract[],
): ObservationAssignment[] | null {
  if (
    observations.length > MAX_OBSERVATIONS ||
    contracts.length > MAX_OBSERVATIONS ||
    contracts.some(
      (contract) =>
        !Number.isSafeInteger(contract.requiredCount) ||
        contract.requiredCount < 1 ||
        contract.requiredCount > MAX_OBSERVATIONS,
    )
  ) {
    return null;
  }
  const slots = contracts.flatMap((contract) =>
    Array.from({ length: contract.requiredCount }, () => contract),
  );
  if (slots.length > MAX_OBSERVATIONS || slots.length !== observations.length) {
    return null;
  }
  const candidates = observations.map((observation) =>
    slots
      .map((contract, slotIndex) => ({ contract, slotIndex }))
      .filter(({ contract }) => matchesContract(observation, contract))
      .map(({ slotIndex }) => slotIndex),
  );
  const slotOwner = Array.from({ length: slots.length }, () => -1);
  const assign = (
    observationIndex: number,
    visitedSlots: Set<number>,
  ): boolean => {
    for (const slotIndex of candidates[observationIndex]) {
      if (visitedSlots.has(slotIndex)) continue;
      visitedSlots.add(slotIndex);
      if (
        slotOwner[slotIndex] === -1 ||
        assign(slotOwner[slotIndex], visitedSlots)
      ) {
        slotOwner[slotIndex] = observationIndex;
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < observations.length; index += 1) {
    if (!assign(index, new Set())) {
      return null;
    }
  }
  const slotByObservation = new Map<number, number>();
  for (const [slotIndex, observationIndex] of slotOwner.entries()) {
    slotByObservation.set(observationIndex, slotIndex);
  }
  return observations.map((observation, observationIndex) => ({
    observation,
    contract: slots[slotByObservation.get(observationIndex) as number],
  }));
}

function verifyConnectorBindings(
  assignment: readonly ObservationAssignment[],
  bindings: readonly SignedObservationConnectorBinding[],
  expectedOperation: ProviderOperationBinding,
  reasons: string[],
): void {
  const byObservationId = new Map<string, SignedObservationConnectorBinding>();
  for (const binding of bindings) {
    if (byObservationId.has(binding.observationId)) {
      reasons.push("connector-binding:duplicate");
    }
    byObservationId.set(binding.observationId, binding);
  }
  if (
    byObservationId.size !== assignment.length ||
    assignment.some(
      ({ observation }) => !byObservationId.has(observation.observationId),
    )
  ) {
    reasons.push("connector-binding:multiset-mismatch");
  }
  for (const { observation, contract } of assignment) {
    const binding = byObservationId.get(observation.observationId);
    if (
      !binding ||
      binding.provider !== contract.connectorProvider ||
      binding.accountRefSha256 !== contract.accountRefSha256 ||
      binding.connectionRefSha256 !== contract.connectionRefSha256 ||
      binding.operation.schema !== expectedOperation.schema ||
      binding.operation.kind !== expectedOperation.kind ||
      binding.operation.providerTargetRefSha256 !==
        expectedOperation.providerTargetRefSha256 ||
      binding.operation.operationInputSha256 !==
        expectedOperation.operationInputSha256
    ) {
      reasons.push(
        `observation:${observation.observationId}:connector-mismatch`,
      );
    }
  }
}

function verifyTrajectoryReferences(
  observations: readonly ScenarioEvidenceObservation[],
  signedStageReferences: readonly SignedStageReference[],
  trajectories: VerifiedScenarioTrajectorySet,
  reasons: string[],
): void {
  const trajectoryById = new Map(
    trajectories.trajectories.map((trajectory) => [
      trajectory.artifact.trajectoryId,
      trajectory,
    ]),
  );
  const expectedReferenceKeys = new Set<string>();
  for (const observation of observations) {
    if (
      !Array.isArray(observation.trajectoryRefs) ||
      observation.trajectoryRefs.length === 0
    ) {
      reasons.push(
        `observation:${observation.observationId}:trajectory-refs-empty`,
      );
      continue;
    }
    for (const reference of observation.trajectoryRefs) {
      const trajectory = trajectoryById.get(reference.trajectoryId);
      const stage = trajectory?.stages.find(
        (candidate) => candidate.stageId === reference.stageId,
      );
      const key = `${observation.observationId}\u0000${reference.trajectoryId}\u0000${reference.stageId}`;
      if (expectedReferenceKeys.has(key)) {
        reasons.push(
          `observation:${observation.observationId}:duplicate-stage-ref`,
        );
      }
      expectedReferenceKeys.add(key);
      if (!trajectory || reference.sha256 !== trajectory.artifact.sha256) {
        reasons.push(
          `observation:${observation.observationId}:trajectory-hash-mismatch`,
        );
      }
      if (!stage) {
        reasons.push(`observation:${observation.observationId}:unknown-stage`);
      } else if (
        Date.parse(observation.observedAtIso) < Date.parse(stage.endedAtIso)
      ) {
        reasons.push(
          `observation:${observation.observationId}:observed-before-stage`,
        );
      }
    }
  }

  const actualReferenceKeys = new Set<string>();
  for (const reference of signedStageReferences) {
    const key = `${reference.observationId}\u0000${reference.trajectoryId}\u0000${reference.stageId}`;
    if (actualReferenceKeys.has(key)) {
      reasons.push("signed-stage-reference:duplicate");
    }
    actualReferenceKeys.add(key);
    const trajectory = trajectoryById.get(reference.trajectoryId);
    const stage = trajectory?.stages.find(
      (candidate) => candidate.stageId === reference.stageId,
    );
    if (!stage || stage.sha256 !== reference.stageSha256) {
      reasons.push("signed-stage-reference:hash-mismatch");
    }
  }
  if (
    actualReferenceKeys.size !== expectedReferenceKeys.size ||
    [...expectedReferenceKeys].some((key) => !actualReferenceKeys.has(key))
  ) {
    reasons.push("signed-stage-reference:multiset-mismatch");
  }
}

function verifyObservationFreshness(
  assignment: readonly ObservationAssignment[],
  payload: ProviderObserverEvidencePayload,
  nowMs: number,
  clockSkewMs: number,
  reasons: string[],
): void {
  const scenarioStartedAt = timestamp(
    payload.scenarioStartedAtIso,
    "scenarioStartedAtIso",
  );
  const scenarioEndedAt = timestamp(
    payload.scenarioEndedAtIso,
    "scenarioEndedAtIso",
  );
  for (const { observation, contract } of assignment) {
    const observedAt = timestamp(
      observation.observedAtIso,
      `observation:${observation.observationId}.observedAtIso`,
    );
    if (
      observedAt < scenarioEndedAt - clockSkewMs ||
      observedAt > nowMs + clockSkewMs ||
      nowMs - observedAt > contract.maxObservationAgeMs + clockSkewMs
    ) {
      reasons.push(
        `observation:${observation.observationId}:stale-or-outside-run`,
      );
    }
    if (observation.kind === "provider-no-effect") {
      const intervalStart = timestamp(
        observation.observationStartedAtIso,
        `observation:${observation.observationId}.observationStartedAtIso`,
      );
      const intervalEnd = timestamp(
        observation.observationEndedAtIso,
        `observation:${observation.observationId}.observationEndedAtIso`,
      );
      if (
        intervalStart > scenarioStartedAt ||
        intervalEnd < scenarioEndedAt - clockSkewMs ||
        intervalEnd < intervalStart
      ) {
        reasons.push(`observation:${observation.observationId}:interval-gap`);
      }
      if (observedAt < intervalEnd - clockSkewMs) {
        reasons.push(
          `observation:${observation.observationId}:observed-before-interval-end`,
        );
      }
      if (
        observation.beforeSnapshotSha256 !== observation.afterSnapshotSha256
      ) {
        reasons.push(`observation:${observation.observationId}:state-changed`);
      }
    }
  }
}

function verifyFinalStateTiming(
  providerPayload: ProviderObserverEvidencePayload,
  semanticPayload: SemanticJudgeEvidencePayload,
  trajectories: VerifiedScenarioTrajectorySet,
  clockSkewMs: number,
  reasons: string[],
): void {
  const scenarioEndedAt = timestamp(
    providerPayload.scenarioEndedAtIso,
    "scenarioEndedAtIso",
  );
  const trajectoryVerifiedAt = timestamp(
    trajectories.verifiedAtIso,
    "trajectories.verifiedAtIso",
  );
  const observerSignedAt = timestamp(
    providerPayload.signedAtIso,
    "signedEvidence.payload.signedAtIso",
  );
  const semanticSignedAt = timestamp(
    semanticPayload.signedAtIso,
    "signedSemanticEvidence.payload.signedAtIso",
  );
  if (trajectoryVerifiedAt < scenarioEndedAt - clockSkewMs) {
    reasons.push("trajectory-verification:before-scenario-end");
  }
  if (
    observerSignedAt < scenarioEndedAt - clockSkewMs ||
    observerSignedAt < trajectoryVerifiedAt - clockSkewMs
  ) {
    reasons.push("observer-signature:before-final-state");
  }
  if (
    semanticSignedAt < scenarioEndedAt - clockSkewMs ||
    semanticSignedAt < trajectoryVerifiedAt - clockSkewMs
  ) {
    reasons.push("semantic-signature:before-final-state");
  }
  for (const observation of providerPayload.observations) {
    const observedAt = timestamp(
      observation.observedAtIso,
      `observation:${observation.observationId}.observedAtIso`,
    );
    if (observerSignedAt < observedAt - clockSkewMs) {
      reasons.push("observer-signature:before-final-state");
    }
    if (observation.kind === "provider-no-effect") {
      const intervalEndedAt = timestamp(
        observation.observationEndedAtIso,
        `observation:${observation.observationId}.observationEndedAtIso`,
      );
      if (observerSignedAt < intervalEndedAt - clockSkewMs) {
        reasons.push("observer-signature:before-final-state");
      }
    }
  }
}

function verifyProviderAssurances(
  assignment: readonly ObservationAssignment[],
  assurances: readonly ProviderEffectAssurance[],
  reasons: string[],
): ProviderQualificationDecision["guarantees"] {
  const effects = assignment.filter(
    (
      row,
    ): row is ObservationAssignment & {
      observation: Extract<
        ScenarioEvidenceObservation,
        { kind: "provider-effect" }
      >;
      contract: Extract<
        ProviderObservationContract,
        { kind: "provider-effect" }
      >;
    } =>
      row.observation.kind === "provider-effect" &&
      row.contract.kind === "provider-effect",
  );
  const assuranceById = new Map<string, ProviderEffectAssurance>();
  for (const assurance of assurances) {
    if (assuranceById.has(assurance.observationId)) {
      reasons.push("provider-assurance:duplicate");
    }
    assuranceById.set(assurance.observationId, assurance);
  }
  if (
    assuranceById.size !== effects.length ||
    effects.some((row) => !assuranceById.has(row.observation.observationId))
  ) {
    reasons.push("provider-assurance:multiset-mismatch");
  }
  let acceptance = true;
  let readback = true;
  let idempotency = true;
  for (const { observation, contract } of effects) {
    const assurance = assuranceById.get(observation.observationId);
    if (!assurance?.providerAccepted) {
      acceptance = false;
      reasons.push(
        `observation:${observation.observationId}:acceptance-unverified`,
      );
    }
    if (
      contract.readbackRequired &&
      (!assurance?.readbackVerified || !isSha256(observation.readbackSha256))
    ) {
      readback = false;
      reasons.push(
        `observation:${observation.observationId}:readback-unverified`,
      );
    }
    if (contract.idempotencyRequired) {
      const proof = assurance?.idempotency;
      if (
        !proof ||
        proof.mode === "unsupported" ||
        !proof.replayVerified ||
        !isSha256(proof.keySha256)
      ) {
        idempotency = false;
        reasons.push(
          `observation:${observation.observationId}:idempotency-unverified`,
        );
      }
    }
  }
  return {
    providerAcceptanceVerified: acceptance,
    providerReadbackVerified: readback,
    providerIdempotencyVerified: idempotency,
    // Provider idempotency/readback narrows duplicate risk but cannot establish
    // end-to-end exactly-once delivery across process and network boundaries.
    exactlyOnce: false,
  };
}

function verifyLocalResults(
  input: DeriveProviderQualificationInput,
  payload: ProviderObserverEvidencePayload,
  reasons: string[],
): void {
  if (
    !["passed", "failed", "skipped"].includes(input.scenarioStatus) ||
    input.finalChecks.length > MAX_FINAL_CHECK_RESULTS
  ) {
    reasons.push("runner-result:invalid-shape");
    return;
  }
  for (const result of input.finalChecks) {
    if (
      !isSha256(result.definitionSha256) ||
      !["passed", "failed", "skipped", "unknown"].includes(result.status)
    ) {
      reasons.push("runner-result:invalid-shape");
      return;
    }
  }
  if (
    payload.runnerResultSha256 !==
    runnerResultSha256({
      scenarioStatus: input.scenarioStatus,
      finalChecks: input.finalChecks,
    })
  ) {
    reasons.push("runner-result:signed-digest-mismatch");
  }
  if (input.scenarioStatus !== "passed") {
    reasons.push(`scenario-status:${input.scenarioStatus}`);
  }
  const expectedChecks = input.manifest.scenario.finalChecks
    .map((check) => check.definitionSha256)
    .sort();
  const actualChecks = input.finalChecks
    .map((check) => check.definitionSha256)
    .sort();
  if (
    expectedChecks.length !== actualChecks.length ||
    expectedChecks.some((hash, index) => hash !== actualChecks[index])
  ) {
    reasons.push("final-check:multiset-mismatch");
  }
  for (const result of input.finalChecks) {
    if (result.status !== "passed") {
      reasons.push(`final-check:${result.definitionSha256}:${result.status}`);
    }
  }
}

function verifySemanticResults(
  manifest: ProviderQualificationManifest,
  payload: SemanticJudgeEvidencePayload,
  reasons: string[],
): void {
  const semanticById = new Map(
    payload.verdicts.map((verdict) => [verdict.criterionId, verdict]),
  );
  if (
    semanticById.size !== payload.verdicts.length ||
    semanticById.size !== manifest.scenario.semanticCriteria.length
  ) {
    reasons.push("semantic-verdict:multiset-mismatch");
  }
  for (const criterion of manifest.scenario.semanticCriteria) {
    const verdict = semanticById.get(criterion.criterionId);
    if (
      !verdict ||
      verdict.rubricSha256 !== criterion.rubricSha256 ||
      verdict.status !== "passed" ||
      !Number.isFinite(verdict.score) ||
      verdict.score < criterion.minimumScore ||
      !isSha256(verdict.requestSha256) ||
      !isSha256(verdict.responseSha256)
    ) {
      reasons.push(`semantic-verdict:${criterion.criterionId}:unqualified`);
    }
  }
}

function pinnedKeyIds(keys: readonly string[], path: string): Set<string> {
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    keys.length > MAX_PINNED_KEYS
  ) {
    throw new Error(`${path} must contain 1-${MAX_PINNED_KEYS} keys`);
  }
  const ids = new Set<string>();
  for (const [index, key] of keys.entries()) {
    if (typeof key !== "string" || key.length > 32_768) {
      throw new Error(`${path}[${index}] must be a bounded PEM string`);
    }
    try {
      const keyId = providerObserverKeyId(key);
      if (ids.has(keyId)) {
        throw new Error(`${path}[${index}] duplicates an earlier key`);
      }
      ids.add(keyId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("duplicates")) {
        throw error;
      }
      // error-policy:J2 preserve the key parser's cause at this protocol boundary.
      throw new Error(
        error instanceof Error && error.message.includes("Ed25519")
          ? `${path}[${index}] must be an Ed25519 public key`
          : `${path}[${index}] is not a valid public key`,
        { cause: error },
      );
    }
  }
  return ids;
}

/**
 * Derive a fail-closed qualification decision. Invalid signatures and missing
 * proof produce an unqualified result; malformed protocol shapes throw before
 * any publication decision can be emitted.
 */
export function deriveProviderQualification(
  input: DeriveProviderQualificationInput,
): ProviderQualificationDecision {
  const rawInput = runtimeRecord(input, "qualification input");
  const scenarioDefinition = canonicalJsonValue(
    inputDataProperty(rawInput, "scenarioDefinition"),
    "scenarioDefinition",
  ) as unknown as ScenarioDefinition;
  const manifest = parseManifestRuntime(
    inputDataProperty(rawInput, "manifest"),
    scenarioDefinition,
  );
  const manifestSignature = parseManifestSignatureRuntime(
    inputDataProperty(rawInput, "manifestSignature"),
  );
  const trajectories = validateVerifiedScenarioTrajectorySet(
    inputDataProperty(rawInput, "trajectories"),
  );
  const signedEvidence = parseSignedEvidenceRuntime(
    inputDataProperty(rawInput, "signedEvidence"),
  );
  const signedSemanticEvidence = parseSemanticEvidenceRuntime(
    inputDataProperty(rawInput, "signedSemanticEvidence"),
  );
  const pinnedManifestAuthorityPublicKeysPem = canonicalJsonValue(
    inputDataProperty(rawInput, "pinnedManifestAuthorityPublicKeysPem"),
    "pinnedManifestAuthorityPublicKeysPem",
  ) as unknown as readonly [string, ...string[]];
  const pinnedObserverPublicKeysPem = canonicalJsonValue(
    inputDataProperty(rawInput, "pinnedObserverPublicKeysPem"),
    "pinnedObserverPublicKeysPem",
  ) as unknown as readonly [string, ...string[]];
  const pinnedSemanticJudgePublicKeysPem = canonicalJsonValue(
    inputDataProperty(rawInput, "pinnedSemanticJudgePublicKeysPem"),
    "pinnedSemanticJudgePublicKeysPem",
  ) as unknown as readonly [string, ...string[]];
  const finalChecks = canonicalJsonValue(
    inputDataProperty(rawInput, "finalChecks"),
    "finalChecks",
  ) as unknown as readonly LocalFinalCheckResult[];
  const scenarioStatus = inputDataProperty(rawInput, "scenarioStatus");
  const nowIso = inputDataProperty(rawInput, "nowIso");
  const rawMaxSignatureAgeMs = inputDataProperty(
    rawInput,
    "maxSignatureAgeMs",
    false,
  );
  const rawMaxClockSkewMs = inputDataProperty(
    rawInput,
    "maxClockSkewMs",
    false,
  );
  input = {
    scenarioDefinition,
    manifest,
    manifestSignature,
    pinnedManifestAuthorityPublicKeysPem,
    trajectories,
    signedEvidence,
    pinnedObserverPublicKeysPem,
    signedSemanticEvidence,
    pinnedSemanticJudgePublicKeysPem,
    scenarioStatus:
      scenarioStatus as DeriveProviderQualificationInput["scenarioStatus"],
    finalChecks,
    nowIso: nowIso as string,
    ...(rawMaxSignatureAgeMs === undefined
      ? {}
      : { maxSignatureAgeMs: rawMaxSignatureAgeMs as number }),
    ...(rawMaxClockSkewMs === undefined
      ? {}
      : { maxClockSkewMs: rawMaxClockSkewMs as number }),
  };
  const reasons: string[] = [];
  const payload = signedEvidence.payload;
  const semanticPayload = signedSemanticEvidence.payload;
  const nowMs = timestamp(input.nowIso, "nowIso");
  const signedAt = timestamp(payload.signedAtIso, "signedAtIso");
  const semanticSignedAt = timestamp(
    semanticPayload.signedAtIso,
    "semanticSignedAtIso",
  );
  const maxSignatureAgeMs =
    input.maxSignatureAgeMs ?? DEFAULT_MAX_SIGNATURE_AGE_MS;
  const clockSkewMs = input.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  if (
    !Number.isSafeInteger(maxSignatureAgeMs) ||
    maxSignatureAgeMs < 0 ||
    !Number.isSafeInteger(clockSkewMs) ||
    clockSkewMs < 0
  ) {
    throw new Error(
      "qualification freshness windows must be non-negative integers",
    );
  }
  const authorityKeyIds = pinnedKeyIds(
    input.pinnedManifestAuthorityPublicKeysPem,
    "pinnedManifestAuthorityPublicKeysPem",
  );
  const observerKeyIds = pinnedKeyIds(
    input.pinnedObserverPublicKeysPem,
    "pinnedObserverPublicKeysPem",
  );
  const semanticKeyIds = pinnedKeyIds(
    input.pinnedSemanticJudgePublicKeysPem,
    "pinnedSemanticJudgePublicKeysPem",
  );
  const manifestObserverKeyIds = new Set(
    manifest.trust.observerSigners.map((signer) => signer.keyId),
  );
  if (
    [...observerKeyIds].some((keyId) => semanticKeyIds.has(keyId)) ||
    [...authorityKeyIds].some(
      (keyId) => observerKeyIds.has(keyId) || semanticKeyIds.has(keyId),
    ) ||
    signedEvidence.keyId === signedSemanticEvidence.keyId ||
    manifestObserverKeyIds.has(manifest.models.judgeKeyId) ||
    manifestObserverKeyIds.has(manifest.trust.manifestAuthorityKeyId) ||
    manifest.models.judgeKeyId === manifest.trust.manifestAuthorityKeyId
  ) {
    reasons.push("semantic-signature:key-not-independent");
  }
  if (
    !verifyManifestAuthority(
      manifestSignature,
      manifest,
      input.pinnedManifestAuthorityPublicKeysPem,
    )
  ) {
    reasons.push("manifest-signature:invalid-or-unpinned");
  }
  const expectedObserverKeyIds = [...manifestObserverKeyIds];
  const expectedObserverKeyId =
    expectedObserverKeyIds.length === 1 ? expectedObserverKeyIds[0] : "";
  if (
    expectedObserverKeyIds.length !== 1 ||
    observerKeyIds.size !== expectedObserverKeyIds.length ||
    expectedObserverKeyIds.some((keyId) => !observerKeyIds.has(keyId))
  ) {
    reasons.push("observer-signature:manifest-pin-mismatch");
  }
  if (
    !verifySignedEvidence(
      signedEvidence,
      input.pinnedObserverPublicKeysPem,
      expectedObserverKeyId,
    )
  ) {
    reasons.push("observer-signature:invalid-or-unpinned");
  }
  if (
    !verifySignedSemanticEvidence(
      signedSemanticEvidence,
      input.pinnedSemanticJudgePublicKeysPem,
      manifest.models.judgeKeyId,
    )
  ) {
    reasons.push("semantic-signature:invalid-or-unpinned");
  }
  if (
    payload.manifestSha256 !== input.manifest.manifestSha256 ||
    payload.runId !== input.manifest.run.runId ||
    payload.runNonce !== input.manifest.run.nonce ||
    payload.scenarioId !== input.manifest.scenario.id
  ) {
    reasons.push("observer-correlation:mismatch");
  }
  if (
    semanticPayload.manifestSha256 !== input.manifest.manifestSha256 ||
    semanticPayload.runId !== input.manifest.run.runId ||
    semanticPayload.runNonce !== input.manifest.run.nonce ||
    semanticPayload.scenarioId !== input.manifest.scenario.id ||
    semanticPayload.trajectorySetSha256 !== input.trajectories.setSha256 ||
    semanticPayload.scenarioEndedAtIso !==
      input.trajectories.scenarioEndedAtIso ||
    semanticPayload.trajectoryVerifiedAtIso !== input.trajectories.verifiedAtIso
  ) {
    reasons.push("semantic-correlation:mismatch");
  }
  if (
    semanticPayload.actingAdapter !== input.manifest.models.actingAdapter ||
    semanticPayload.actingProvider !== input.manifest.models.actingProvider ||
    semanticPayload.actingModel !== input.manifest.models.actingModel ||
    semanticPayload.judgeProvider !== input.manifest.models.judgeProvider ||
    semanticPayload.judgeModel !== input.manifest.models.judgeModel ||
    signedSemanticEvidence.keyId !== input.manifest.models.judgeKeyId ||
    (semanticPayload.actingProvider === semanticPayload.judgeProvider &&
      semanticPayload.actingModel === semanticPayload.judgeModel)
  ) {
    reasons.push("semantic-identity:mismatch");
  }
  if (
    input.trajectories.runId !== input.manifest.run.runId ||
    input.trajectories.scenarioId !== input.manifest.scenario.id ||
    payload.trajectorySetSha256 !== input.trajectories.setSha256 ||
    payload.scenarioStartedAtIso !== input.trajectories.scenarioStartedAtIso ||
    payload.scenarioEndedAtIso !== input.trajectories.scenarioEndedAtIso ||
    payload.trajectoryVerifiedAtIso !== input.trajectories.verifiedAtIso
  ) {
    reasons.push("trajectory-set:correlation-mismatch");
  }
  if (
    signedAt > nowMs + clockSkewMs ||
    nowMs - signedAt > maxSignatureAgeMs + clockSkewMs
  ) {
    reasons.push("observer-signature:stale-or-future");
  }
  if (
    semanticSignedAt > nowMs + clockSkewMs ||
    nowMs - semanticSignedAt > maxSignatureAgeMs + clockSkewMs
  ) {
    reasons.push("semantic-signature:stale-or-future");
  }
  verifyFinalStateTiming(
    payload,
    semanticPayload,
    input.trajectories,
    clockSkewMs,
    reasons,
  );

  const provenanceById = new Map<string, ScenarioEvidenceObserverProvenance>();
  const signerByObserverId = new Map(
    input.manifest.trust.observerSigners.map((signer) => [
      signer.observerId,
      signer.keyId,
    ]),
  );
  for (const observer of payload.observerProvenance) {
    if (provenanceById.has(observer.observerId)) {
      reasons.push("observer-provenance:duplicate");
    }
    provenanceById.set(observer.observerId, observer);
    if (signerByObserverId.get(observer.observerId) !== signedEvidence.keyId) {
      reasons.push(
        `observer-provenance:${observer.observerId}:signer-mismatch`,
      );
    }
  }
  if (
    provenanceById.size !== signerByObserverId.size ||
    [...signerByObserverId.keys()].some(
      (observerId) => !provenanceById.has(observerId),
    )
  ) {
    reasons.push("observer-provenance:manifest-multiset-mismatch");
  }
  for (const observation of payload.observations) {
    const observer = provenanceById.get(observation.observerId);
    if (
      !observer ||
      observer.kind !== observation.source.kind ||
      observer.environment !== observation.source.environment
    ) {
      reasons.push(
        `observation:${observation.observationId}:observer-mismatch`,
      );
    }
  }

  const assignment = exactObservationAssignment(
    payload.observations,
    input.manifest.requiredObservations,
  );
  if (!assignment) {
    reasons.push("observation:exact-multiset-mismatch");
  }
  verifyTrajectoryReferences(
    payload.observations,
    payload.stageReferences,
    input.trajectories,
    reasons,
  );
  const effectiveAssignment = assignment ?? [];
  verifyConnectorBindings(
    effectiveAssignment,
    payload.connectorBindings,
    input.manifest.target.operation,
    reasons,
  );
  verifyObservationFreshness(
    effectiveAssignment,
    payload,
    nowMs,
    clockSkewMs,
    reasons,
  );
  const guarantees = verifyProviderAssurances(
    effectiveAssignment,
    payload.providerEffectAssurances,
    reasons,
  );
  verifyLocalResults(input, payload, reasons);
  verifySemanticResults(input.manifest, semanticPayload, reasons);

  const uniqueReasons = [...new Set(reasons)].sort();
  if (
    uniqueReasons.includes("observer-signature:invalid-or-unpinned") ||
    uniqueReasons.includes("observer-signature:manifest-pin-mismatch") ||
    uniqueReasons.includes("manifest-signature:invalid-or-unpinned") ||
    uniqueReasons.includes("manifest:hash-mismatch") ||
    uniqueReasons.includes("observer-correlation:mismatch") ||
    uniqueReasons.includes("semantic-signature:invalid-or-unpinned") ||
    uniqueReasons.includes("semantic-signature:key-not-independent") ||
    uniqueReasons.includes("semantic-correlation:mismatch")
  ) {
    guarantees.providerAcceptanceVerified = false;
    guarantees.providerReadbackVerified = false;
    guarantees.providerIdempotencyVerified = false;
  }
  const matchedObservationContracts = effectiveAssignment
    .map(({ observation, contract }) => ({
      observationId: observation.observationId,
      contractId: contract.contractId,
    }))
    .sort((left, right) =>
      left.observationId.localeCompare(right.observationId),
    );
  if (uniqueReasons.length > 0) {
    return {
      manifestSha256: input.manifest.manifestSha256,
      qualification: {
        status: "unqualified",
        publishable: false,
        reasons: uniqueReasons as [string, ...string[]],
      },
      matchedObservationContracts,
      guarantees,
    };
  }
  return {
    manifestSha256: input.manifest.manifestSha256,
    qualification: {
      status: "qualified",
      publishable: true,
      reasons: [],
    },
    matchedObservationContracts,
    guarantees,
  };
}
