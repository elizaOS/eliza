/**
 * Bridges validated raw provider-controller output into the generic external
 * canary coordinator. It binds every remote request to the authorized run,
 * keeps signing keys outside this process, requires distinct observer and
 * semantic-judge services, and withholds publication until signed cleanup is
 * verified.
 */

import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { ScenarioReport } from "../types.ts";
import {
  BLUEBUBBLES_RAW_RECEIPT_SCHEMA,
  type BlueBubblesRawReceipt,
} from "./bluebubbles-operator-controller.ts";
import type { ProviderCanaryScenarioId } from "./canary-catalog.ts";
import {
  type ProviderControllerFamily,
  providerCanaryControllerContract,
} from "./controller-registry.ts";
import type { VerifiedDeployedCanaryExecution } from "./deployed-capability-contract.ts";
import {
  DUFFEL_RAW_RECEIPT_SCHEMA,
  type DuffelRawReceipt,
} from "./duffel-operator-controller.ts";
import type {
  ExternalProviderCanaryCapabilities,
  ExternalProviderCanaryContext,
  ExternalProviderCanaryStage,
} from "./external-canary-orchestrator.ts";
import {
  GOOGLE_WORKSPACE_RAW_RECEIPT_SCHEMA,
  type GoogleWorkspaceRawReceipt,
} from "./google-workspace-operator-controller.ts";
import {
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
} from "./manifest.ts";
import {
  MESSAGING_RAW_RECEIPT_SCHEMA,
  type MessagingRawReceipt,
} from "./messaging-operator-controller.ts";
import type { ProviderOperationKind } from "./operation-binding.ts";
import {
  PROVIDER_OBSERVER_EVIDENCE_SCHEMA,
  type ProviderObserverEvidencePayload,
  providerObserverKeyId,
  runnerResultSha256,
  SEMANTIC_JUDGE_EVIDENCE_SCHEMA,
  type SemanticJudgeEvidencePayload,
  type SignedProviderObserverEvidence,
  type SignedSemanticJudgeEvidence,
} from "./qualification.ts";
import {
  type ProviderObserverSignerClient,
  preflightIndependentEvidenceSigners,
  type SemanticJudgeSignerClient,
} from "./remote-evidence-signer-client.ts";
import {
  type VerifiedScenarioTrajectorySet,
  validateVerifiedScenarioTrajectorySet,
} from "./trajectory-verifier.ts";

export const PROVIDER_CLEANUP_PROOF_SCHEMA =
  "eliza.provider-canary-cleanup-proof.v1" as const;
export const DEPLOYED_COMPOSITE_RAW_MATERIAL_SCHEMA =
  "eliza.provider-canary-deployed-composite-raw-material.v1" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CLEANUP_PROOF_MAX_AGE_MS = 5 * 60_000;
const CLEANUP_PROOF_MAX_CLOCK_SKEW_MS = 5_000;

export type BridgeableRawControllerMaterial =
  | BlueBubblesRawReceipt
  | DuffelRawReceipt
  | GoogleWorkspaceRawReceipt
  | MessagingRawReceipt
  | DeployedCompositeRawControllerMaterial;

export interface DeployedCompositeRawControllerMaterial {
  schema: typeof DEPLOYED_COMPOSITE_RAW_MATERIAL_SCHEMA;
  scenarioId:
    | "provider.discord.confirmed-send"
    | "provider.slack.confirmed-send"
    | "provider.twilio-sms.confirmed-send"
    | "provider.twilio-voice.confirmed-call";
  operationKind:
    | "discord.message-send"
    | "slack.message-send"
    | "twilio.sms-send"
    | "twilio.call-create";
  controllerFamily: "discord" | "slack" | "twilio";
  deployedExecution: VerifiedDeployedCanaryExecution;
  providerReadback: unknown;
  qualificationClaimed: false;
}

export type ProviderControllerBridgeAvailability =
  | "raw-controller-bridgeable"
  | "requires-deployed-composite-adapter";

export interface ProviderControllerBridgeContract {
  scenarioId: ProviderCanaryScenarioId;
  operationKind: ProviderOperationKind;
  controllerFamily: ProviderControllerFamily;
  availability: ProviderControllerBridgeAvailability;
}

const BRIDGE_AVAILABILITY = Object.freeze({
  "provider.bluebubbles-imessage.confirmed-send": "raw-controller-bridgeable",
  "provider.discord.confirmed-send": "requires-deployed-composite-adapter",
  "provider.duffel-travel.booking": "raw-controller-bridgeable",
  "provider.gmail.confirmed-send": "raw-controller-bridgeable",
  "provider.google-calendar.create": "raw-controller-bridgeable",
  "provider.google-sheets.create": "raw-controller-bridgeable",
  "provider.signal.confirmed-send": "raw-controller-bridgeable",
  "provider.slack.confirmed-send": "requires-deployed-composite-adapter",
  "provider.telegram.confirmed-send": "raw-controller-bridgeable",
  "provider.twilio-sms.confirmed-send": "requires-deployed-composite-adapter",
  "provider.twilio-voice.confirmed-call": "requires-deployed-composite-adapter",
  "provider.whatsapp.confirmed-send": "raw-controller-bridgeable",
  "provider.x-dm.confirmed-send": "raw-controller-bridgeable",
} as const satisfies Record<
  ProviderCanaryScenarioId,
  ProviderControllerBridgeAvailability
>);

export const PROVIDER_CONTROLLER_BRIDGE_CONTRACTS = Object.freeze(
  Object.fromEntries(
    Object.entries(BRIDGE_AVAILABILITY).map(([scenarioId, availability]) => {
      const controller = providerCanaryControllerContract(scenarioId);
      return [
        scenarioId,
        Object.freeze({
          scenarioId: controller.scenarioId,
          operationKind: controller.operationKind,
          controllerFamily: controller.controllerFamily,
          availability,
        }),
      ];
    }),
  ) as unknown as Readonly<
    Record<ProviderCanaryScenarioId, ProviderControllerBridgeContract>
  >,
);

export interface ProviderBridgeCorrelation {
  scenarioId: ProviderCanaryScenarioId;
  operationKind: ProviderOperationKind;
  controllerFamily: ProviderControllerFamily;
  runId: string;
  runNonce: string;
  manifestSha256: string;
  targetOperationSha256: string;
  failureProbesSha256: string;
}

export interface ProviderControllerExecutionResult {
  rawControllerMaterial: BridgeableRawControllerMaterial;
  runnerReport: ScenarioReport;
  trajectories: VerifiedScenarioTrajectorySet;
  cleanupScopeSha256: string;
}

export interface DeployedProviderControllerClient {
  endpointOrigin: string;
  controllerFamily: ProviderControllerFamily;
  execute(input: {
    correlation: ProviderBridgeCorrelation;
    providerTarget: unknown;
    operationInput: unknown;
    failureProbes: ExternalProviderCanaryContext["failureProbes"];
  }): Promise<ProviderControllerExecutionResult>;
}

export interface IndependentProviderObserverIdentity {
  endpointOrigin: string;
  administrativeDomain: string;
}

export interface ProviderObserverSigningSession {
  sessionId: string;
  correlationSha256: string;
}

export type ProviderObserverUnsignedMaterial = Pick<
  ProviderObserverEvidencePayload,
  | "observerProvenance"
  | "observations"
  | "connectorBindings"
  | "failureProbeObservations"
  | "stageReferences"
  | "providerEffectAssurances"
>;

export interface IndependentProviderObserverClient
  extends IndependentProviderObserverIdentity {
  beginObservation(input: {
    correlation: ProviderBridgeCorrelation;
  }): Promise<ProviderObserverSigningSession>;
  complete(input: {
    correlation: ProviderBridgeCorrelation;
    session: ProviderObserverSigningSession;
    rawControllerMaterial: BridgeableRawControllerMaterial;
    rawControllerMaterialSha256: string;
    runnerReport: ScenarioReport;
    runnerReportSha256: string;
    runnerResultSha256: string;
    trajectories: VerifiedScenarioTrajectorySet;
  }): Promise<ProviderObserverUnsignedMaterial>;
}

export interface IndependentSemanticJudgeClient {
  evaluate(input: {
    correlation: ProviderBridgeCorrelation;
    rawControllerMaterial: BridgeableRawControllerMaterial;
    rawControllerMaterialSha256: string;
    runnerReport: ScenarioReport;
    runnerReportSha256: string;
    trajectories: VerifiedScenarioTrajectorySet;
    observerEvidence: SignedProviderObserverEvidence;
    observerEnvelopeSha256: string;
  }): Promise<SemanticJudgeEvidencePayload["verdicts"]>;
}

export interface ProviderCleanupProofPayload {
  schema: typeof PROVIDER_CLEANUP_PROOF_SCHEMA;
  scenarioId: ProviderCanaryScenarioId;
  runId: string;
  runNonce: string;
  manifestSha256: string;
  cleanupScopeSha256: string;
  rawControllerMaterialSha256: string;
  qualificationArtifactSha256?: string;
  disposition: "cleaned" | "no-resources-created";
  completedAtIso: string;
}

export interface SignedProviderCleanupProof {
  keyId: string;
  payload: ProviderCleanupProofPayload;
  signature: string;
}

export interface RemoteProviderCleanupClient {
  endpointOrigin: string;
  administrativeDomain: string;
  keyId: string;
  publicKeyPem: string;
  cleanupAndSign(input: {
    correlation: ProviderBridgeCorrelation;
    cleanupScopeSha256: string;
    rawControllerMaterialSha256: string;
    qualificationArtifactSha256?: string;
    completedStages: readonly ExternalProviderCanaryStage[];
    failed: boolean;
  }): Promise<SignedProviderCleanupProof>;
}

export interface CreateProviderControllerOrchestratorBridgeInput {
  scenarioId: ProviderCanaryScenarioId;
  operationKind: ProviderOperationKind;
  controller: DeployedProviderControllerClient;
  observer: IndependentProviderObserverClient;
  semanticJudge: IndependentSemanticJudgeClient;
  observerSigner: ProviderObserverSignerClient;
  semanticJudgeSigner: SemanticJudgeSignerClient;
  cleanup: RemoteProviderCleanupClient;
  pinnedObserverPublicKeysPem: readonly [string, ...string[]];
  pinnedSemanticJudgePublicKeysPem: readonly [string, ...string[]];
  pinnedCleanupPublicKeysPem: readonly [string, ...string[]];
  now?: () => Date;
}

export type ProviderControllerOperatorCapabilities = Omit<
  ExternalProviderCanaryCapabilities,
  "publisher"
>;

export interface ProviderControllerOrchestratorBridge {
  capabilities: ProviderControllerOperatorCapabilities;
  /** Public-only cleanup signer pin already checked against bridge trust input. */
  cleanupPublicKeyPem: string;
  /** Consume the verified proof exactly once for atomic adjacent publication. */
  takeVerifiedCleanupProof(): SignedProviderCleanupProof;
}

interface CompletedControllerRun extends ProviderControllerExecutionResult {
  rawControllerMaterialSha256: string;
  runnerReportSha256: string;
  runnerResultSha256: string;
}

function fail(message: string): never {
  throw new Error(`provider controller-orchestrator bridge ${message}`);
}

function assertClosedObject(input: {
  value: unknown;
  label: string;
  dataKeys: readonly string[];
  functionKeys: readonly string[];
  optionalFunctionKeys?: readonly string[];
}): void {
  if (
    input.value === null ||
    typeof input.value !== "object" ||
    Array.isArray(input.value) ||
    (Object.getPrototypeOf(input.value) !== Object.prototype &&
      Object.getPrototypeOf(input.value) !== null)
  ) {
    fail(`${input.label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input.value);
  const optional = input.optionalFunctionKeys ?? [];
  const allowed = new Set([
    ...input.dataKeys,
    ...input.functionKeys,
    ...optional,
  ]);
  const missing = [...input.dataKeys, ...input.functionKeys].filter(
    (key) => descriptors[key] === undefined,
  );
  const unknown = Object.keys(descriptors).filter((key) => !allowed.has(key));
  const accessors = Object.entries(descriptors)
    .filter(
      ([, descriptor]) =>
        descriptor.get !== undefined || descriptor.set !== undefined,
    )
    .map(([key]) => key);
  const invalidFunctions = [...input.functionKeys, ...optional].filter(
    (key) =>
      descriptors[key] !== undefined &&
      typeof descriptors[key]?.value !== "function",
  );
  if (
    missing.length > 0 ||
    unknown.length > 0 ||
    accessors.length > 0 ||
    invalidFunctions.length > 0
  ) {
    fail(
      `${input.label} violates the closed capability shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"}; accessors=${accessors.join(",") || "none"}; invalidFunctions=${invalidFunctions.join(",") || "none"})`,
    );
  }
}

function requireHttpsOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // error-policy:J3 Remote service identity is untrusted operator input.
    fail(`${label} endpointOrigin is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/" ||
    value !== url.origin
  ) {
    fail(
      `${label} endpointOrigin must be an exact credential-free HTTPS origin`,
    );
  }
  return value;
}

function requireHash(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) fail(`${label} must be a SHA-256 digest`);
  return value;
}

function validateCleanupSignerIdentity(
  signer: RemoteProviderCleanupClient,
  pins: readonly [string, ...string[]],
  label: string,
): void {
  requireHttpsOrigin(signer.endpointOrigin, label);
  if (signer.administrativeDomain.trim().length === 0) {
    fail(`${label} administrativeDomain is required`);
  }
  const actualKeyId = providerObserverKeyId(signer.publicKeyPem);
  if (signer.keyId !== actualKeyId)
    fail(`${label} keyId does not match its public key`);
  const pinnedIds = new Set(pins.map((pin) => providerObserverKeyId(pin)));
  if (!pinnedIds.has(actualKeyId))
    fail(`${label} public key is not deployment-pinned`);
}

function correlationFor(
  context: ExternalProviderCanaryContext,
  contract: ProviderControllerBridgeContract,
): ProviderBridgeCorrelation {
  const manifest = context.preflight.authorization.manifest;
  return Object.freeze({
    scenarioId: contract.scenarioId,
    operationKind: contract.operationKind,
    controllerFamily: contract.controllerFamily,
    runId: manifest.run.runId,
    runNonce: manifest.run.nonce,
    manifestSha256: manifest.manifestSha256,
    targetOperationSha256: canonicalSha256(
      manifest.target.operation,
      "providerBridge.targetOperation",
    ),
    failureProbesSha256: canonicalSha256(
      manifest.requiredFailureProbes,
      "providerBridge.failureProbes",
    ),
  });
}

function validateContext(
  context: ExternalProviderCanaryContext,
  contract: ProviderControllerBridgeContract,
): ProviderBridgeCorrelation {
  if (
    context.scenario.id !== contract.scenarioId ||
    context.preflight.targetBinding.kind !== contract.operationKind
  ) {
    fail(
      "authorized context does not match the selected canonical controller contract",
    );
  }
  return correlationFor(context, contract);
}

function rawReceiptExpectedSchema(family: ProviderControllerFamily): string {
  switch (family) {
    case "bluebubbles":
      return BLUEBUBBLES_RAW_RECEIPT_SCHEMA;
    case "duffel":
      return DUFFEL_RAW_RECEIPT_SCHEMA;
    case "google-workspace":
      return GOOGLE_WORKSPACE_RAW_RECEIPT_SCHEMA;
    case "messaging":
      return MESSAGING_RAW_RECEIPT_SCHEMA;
    case "discord":
    case "slack":
    case "twilio":
      return DEPLOYED_COMPOSITE_RAW_MATERIAL_SCHEMA;
  }
}

function directRawReceiptKeys(
  family: Exclude<ProviderControllerFamily, "discord" | "slack" | "twilio">,
): readonly string[] {
  switch (family) {
    case "bluebubbles":
      return [
        "schema",
        "scenarioId",
        "operationKind",
        "collectedAtIso",
        "boundary",
        "ingress",
        "readback",
        "replay",
        "failureProbes",
        "trajectory",
        "qualificationClaimed",
      ];
    case "duffel":
      return [
        "schema",
        "scenarioId",
        "collectedAtIso",
        "credential",
        "proposal",
        "preapprovalNoEffect",
        "approval",
        "readback",
        "replay",
        "failureProbes",
        "trajectory",
        "qualificationClaimed",
      ];
    case "google-workspace":
    case "messaging":
      return [
        "schema",
        "scenarioId",
        "operationKind",
        "collectedAtIso",
        "credential",
        "ingress",
        "readback",
        "replay",
        "failureProbes",
        "trajectory",
        "qualificationClaimed",
      ];
  }
}

function localRunnerResultSha256(
  context: ExternalProviderCanaryContext,
  report: ScenarioReport,
): string {
  const definitions =
    context.preflight.authorization.manifest.scenario.finalChecks;
  if (report.finalChecks.length !== definitions.length) {
    fail(
      "runner report final-check cardinality differs from the signed manifest",
    );
  }
  return runnerResultSha256({
    scenarioStatus: report.status,
    finalChecks: definitions.map((definition, index) => {
      const result = report.finalChecks[index];
      if (result.type !== definition.type) {
        fail(
          `runner final check ${index} type differs from the signed manifest`,
        );
      }
      return {
        definitionSha256: definition.definitionSha256,
        status: result.status,
      };
    }),
  });
}

function validateControllerRun(
  context: ExternalProviderCanaryContext,
  contract: ProviderControllerBridgeContract,
  value: ProviderControllerExecutionResult,
): CompletedControllerRun {
  assertClosedObject({
    value,
    label: "controller execution result",
    dataKeys: [
      "rawControllerMaterial",
      "runnerReport",
      "trajectories",
      "cleanupScopeSha256",
    ],
    functionKeys: [],
  });
  const raw = canonicalJsonValue(
    value.rawControllerMaterial,
    "providerBridge.rawControllerMaterial",
  ) as unknown as BridgeableRawControllerMaterial;
  const rawRecord = raw as unknown as Record<string, unknown>;
  if (
    rawRecord.schema !== rawReceiptExpectedSchema(contract.controllerFamily) ||
    rawRecord.scenarioId !== contract.scenarioId ||
    rawRecord.qualificationClaimed !== false ||
    (Object.hasOwn(rawRecord, "operationKind") &&
      rawRecord.operationKind !== contract.operationKind)
  ) {
    fail(
      "raw controller receipt does not match the canonical scenario contract",
    );
  }
  if (
    value.runnerReport.id !== contract.scenarioId ||
    value.runnerReport.status !== "passed" ||
    value.runnerReport.error !== undefined ||
    value.runnerReport.executionProfile !== "provider-qualified" ||
    value.runnerReport.evidenceScope !== "provider-certification"
  ) {
    fail("runner report is not the authorized provider-certification report");
  }
  const trajectories = validateVerifiedScenarioTrajectorySet(
    value.trajectories,
  );
  const manifest = context.preflight.authorization.manifest;
  if (contract.availability === "requires-deployed-composite-adapter") {
    const expectedKeys = [
      "schema",
      "scenarioId",
      "operationKind",
      "controllerFamily",
      "deployedExecution",
      "providerReadback",
      "qualificationClaimed",
    ] as const;
    const deployed = rawRecord.deployedExecution as
      | VerifiedDeployedCanaryExecution
      | undefined;
    if (
      Object.keys(rawRecord).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(rawRecord, key)) ||
      rawRecord.controllerFamily !== contract.controllerFamily ||
      deployed === undefined ||
      rawRecord.providerReadback === null ||
      rawRecord.providerReadback === undefined ||
      deployed.qualificationClaimed !== false ||
      deployed.binding.scenarioId !== contract.scenarioId ||
      deployed.binding.runId !== manifest.run.runId ||
      deployed.binding.manifestSha256 !== manifest.manifestSha256 ||
      deployed.cleanup.status !== "cleaned"
    ) {
      fail(
        "deployed composite adapter material is incomplete, cross-run, or unreconciled",
      );
    }
  } else {
    const family = contract.controllerFamily;
    if (family === "discord" || family === "slack" || family === "twilio") {
      fail("controller registry availability and family are inconsistent");
    }
    const expectedKeys = directRawReceiptKeys(family);
    if (
      Object.keys(rawRecord).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(rawRecord, key))
    ) {
      fail("raw controller receipt violates its closed top-level shape");
    }
  }
  const rawTrajectorySha256 =
    (rawRecord.trajectory as { setSha256?: unknown } | undefined)?.setSha256 ??
    (
      rawRecord.deployedExecution as
        | { trajectories?: { setSha256?: unknown } }
        | undefined
    )?.trajectories?.setSha256;
  if (
    trajectories.runId !== manifest.run.runId ||
    trajectories.scenarioId !== contract.scenarioId ||
    rawTrajectorySha256 !== trajectories.setSha256
  ) {
    fail(
      "raw receipt trajectory does not match the verified authorized trajectory set",
    );
  }
  requireHash(value.cleanupScopeSha256, "cleanupScopeSha256");
  const runnerReport = canonicalJsonValue(
    value.runnerReport,
    "providerBridge.runnerReport",
  ) as unknown as ScenarioReport;
  return Object.freeze({
    rawControllerMaterial: raw,
    runnerReport,
    trajectories,
    cleanupScopeSha256: value.cleanupScopeSha256,
    rawControllerMaterialSha256: canonicalSha256(
      raw,
      "providerBridge.rawControllerMaterial",
    ),
    runnerReportSha256: canonicalSha256(
      runnerReport,
      "providerBridge.runnerReport",
    ),
    runnerResultSha256: localRunnerResultSha256(context, runnerReport),
  });
}

function assertEvidenceCorrelation(
  correlation: ProviderBridgeCorrelation,
  trajectories: VerifiedScenarioTrajectorySet,
  observer: SignedProviderObserverEvidence,
  semantic: SignedSemanticJudgeEvidence | undefined,
): void {
  const payloads =
    semantic === undefined
      ? [observer.payload]
      : [observer.payload, semantic.payload];
  for (const payload of payloads) {
    if (
      payload.scenarioId !== correlation.scenarioId ||
      payload.runId !== correlation.runId ||
      payload.runNonce !== correlation.runNonce ||
      payload.manifestSha256 !== correlation.manifestSha256 ||
      payload.trajectorySetSha256 !== trajectories.setSha256
    ) {
      fail("remote signer returned a cross-run evidence envelope");
    }
  }
}

function canonicalObserverMaterial(
  value: ProviderObserverUnsignedMaterial,
): ProviderObserverUnsignedMaterial {
  const material = canonicalJsonValue(
    value,
    "providerBridge.observerMaterial",
  ) as unknown as ProviderObserverUnsignedMaterial;
  const keys = [
    "observerProvenance",
    "observations",
    "connectorBindings",
    "failureProbeObservations",
    "stageReferences",
    "providerEffectAssurances",
  ] as const;
  if (
    Object.keys(material).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(material, key))
  ) {
    fail("observer returned material outside the closed unsigned shape");
  }
  return material;
}

function bridgeNowIso(
  input: CreateProviderControllerOrchestratorBridgeInput,
): string {
  const now = (input.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime()))
    fail("bridge clock returned an invalid time");
  return now.toISOString();
}

function buildObserverPayload(input: {
  correlation: ProviderBridgeCorrelation;
  run: CompletedControllerRun;
  material: ProviderObserverUnsignedMaterial;
  signedAtIso: string;
}): ProviderObserverEvidencePayload {
  return Object.freeze({
    schema: PROVIDER_OBSERVER_EVIDENCE_SCHEMA,
    manifestSha256: input.correlation.manifestSha256,
    runId: input.correlation.runId,
    runNonce: input.correlation.runNonce,
    scenarioId: input.correlation.scenarioId,
    scenarioStartedAtIso: input.run.trajectories.scenarioStartedAtIso,
    scenarioEndedAtIso: input.run.trajectories.scenarioEndedAtIso,
    trajectoryVerifiedAtIso: input.run.trajectories.verifiedAtIso,
    signedAtIso: input.signedAtIso,
    trajectorySetSha256: input.run.trajectories.setSha256,
    runnerResultSha256: input.run.runnerResultSha256,
    ...input.material,
  });
}

function buildSemanticPayload(input: {
  context: ExternalProviderCanaryContext;
  correlation: ProviderBridgeCorrelation;
  run: CompletedControllerRun;
  verdicts: SemanticJudgeEvidencePayload["verdicts"];
  signedAtIso: string;
}): SemanticJudgeEvidencePayload {
  const models = input.context.preflight.authorization.manifest.models;
  return Object.freeze({
    schema: SEMANTIC_JUDGE_EVIDENCE_SCHEMA,
    manifestSha256: input.correlation.manifestSha256,
    runId: input.correlation.runId,
    runNonce: input.correlation.runNonce,
    scenarioId: input.correlation.scenarioId,
    scenarioEndedAtIso: input.run.trajectories.scenarioEndedAtIso,
    trajectoryVerifiedAtIso: input.run.trajectories.verifiedAtIso,
    signedAtIso: input.signedAtIso,
    trajectorySetSha256: input.run.trajectories.setSha256,
    actingAdapter: models.actingAdapter,
    actingProvider: models.actingProvider,
    actingModel: models.actingModel,
    judgeProvider: models.judgeProvider,
    judgeModel: models.judgeModel,
    verdicts: canonicalJsonValue(
      input.verdicts,
      "providerBridge.semanticVerdicts",
    ) as unknown as SemanticJudgeEvidencePayload["verdicts"],
  });
}

function cleanupSigningBytes(payload: ProviderCleanupProofPayload): Buffer {
  return Buffer.from(
    canonicalJson(canonicalJsonValue(payload, "cleanupProof")),
    "utf8",
  );
}

export interface VerifyProviderCleanupProofInput {
  proof: SignedProviderCleanupProof;
  pinnedPublicKeysPem: readonly [string, ...string[]];
  expected: {
    scenarioId: ProviderCanaryScenarioId;
    runId: string;
    runNonce: string;
    manifestSha256: string;
    cleanupScopeSha256: string;
    rawControllerMaterialSha256: string;
    qualificationArtifactSha256?: string;
    scenarioEndedAtIso: string;
    keyId?: string;
  };
  now: Date;
}

/** Reverify a cleanup capsule independently of the process that executed it. */
export function verifyProviderCleanupProof(
  input: VerifyProviderCleanupProofInput,
): SignedProviderCleanupProof {
  const { proof, expected, now } = input;
  assertClosedObject({
    value: proof,
    label: "cleanup proof",
    dataKeys: ["keyId", "payload", "signature"],
    functionKeys: [],
  });
  const proofDescriptors = Object.getOwnPropertyDescriptors(proof);
  const payloadDescriptor = proofDescriptors.payload;
  if (!payloadDescriptor || !("value" in payloadDescriptor)) {
    fail("cleanup proof payload must be a data property");
  }
  const payload = payloadDescriptor.value as unknown as Record<string, unknown>;
  const payloadKeys = [
    "schema",
    "scenarioId",
    "runId",
    "runNonce",
    "manifestSha256",
    "cleanupScopeSha256",
    "rawControllerMaterialSha256",
    "disposition",
    "completedAtIso",
  ] as const;
  const allowedPayloadKeys = new Set([
    ...payloadKeys,
    "qualificationArtifactSha256",
  ]);
  const payloadDescriptors =
    payload === null || typeof payload !== "object"
      ? {}
      : Object.getOwnPropertyDescriptors(payload);
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payloadDescriptors).some(
      (key) => !allowedPayloadKeys.has(key),
    ) ||
    payloadKeys.some((key) => !Object.hasOwn(payloadDescriptors, key)) ||
    Object.values(payloadDescriptors).some(
      (descriptor) => !("value" in descriptor),
    )
  ) {
    fail("cleanup service returned a proof with a non-canonical shape");
  }
  requireHash(proof.payload.cleanupScopeSha256, "cleanupScopeSha256");
  requireHash(
    proof.payload.rawControllerMaterialSha256,
    "rawControllerMaterialSha256",
  );
  if (proof.payload.qualificationArtifactSha256 !== undefined) {
    requireHash(
      proof.payload.qualificationArtifactSha256,
      "qualificationArtifactSha256",
    );
  }
  const completedAt = Date.parse(proof.payload.completedAtIso);
  if (
    (expected.keyId !== undefined && proof.keyId !== expected.keyId) ||
    proof.payload.schema !== PROVIDER_CLEANUP_PROOF_SCHEMA ||
    proof.payload.scenarioId !== expected.scenarioId ||
    proof.payload.runId !== expected.runId ||
    proof.payload.runNonce !== expected.runNonce ||
    proof.payload.manifestSha256 !== expected.manifestSha256 ||
    proof.payload.cleanupScopeSha256 !== expected.cleanupScopeSha256 ||
    proof.payload.rawControllerMaterialSha256 !==
      expected.rawControllerMaterialSha256 ||
    proof.payload.qualificationArtifactSha256 !==
      expected.qualificationArtifactSha256 ||
    !["cleaned", "no-resources-created"].includes(proof.payload.disposition) ||
    !Number.isFinite(completedAt) ||
    new Date(completedAt).toISOString() !== proof.payload.completedAtIso ||
    completedAt < Date.parse(expected.scenarioEndedAtIso) ||
    completedAt < now.getTime() - CLEANUP_PROOF_MAX_AGE_MS ||
    completedAt > now.getTime() + CLEANUP_PROOF_MAX_CLOCK_SKEW_MS
  ) {
    fail("cleanup service returned an invalid or cross-run proof");
  }
  if (!BASE64URL_PATTERN.test(proof.signature)) {
    fail("cleanup proof signature encoding is invalid");
  }
  const signature = Buffer.from(proof.signature, "base64url");
  const pinnedKey = input.pinnedPublicKeysPem.find(
    (key) => providerObserverKeyId(key) === proof.keyId,
  );
  if (
    pinnedKey === undefined ||
    signature.length !== 64 ||
    !verifySignature(
      null,
      cleanupSigningBytes(proof.payload),
      createPublicKey(pinnedKey),
      signature,
    )
  ) {
    fail("cleanup proof signature is invalid");
  }
  return canonicalJsonValue(
    proof,
    "providerBridge.cleanupProof",
  ) as unknown as SignedProviderCleanupProof;
}

/**
 * Create generic coordinator capabilities for one reviewed raw controller.
 * Construction performs all static trust checks so unsupported or aliased
 * services fail before the observer or deployed ingress is contacted.
 */
export function createProviderControllerOrchestratorBridge(
  input: CreateProviderControllerOrchestratorBridgeInput,
): ProviderControllerOrchestratorBridge {
  assertClosedObject({
    value: input,
    label: "bridge input",
    dataKeys: [
      "scenarioId",
      "operationKind",
      "controller",
      "observer",
      "semanticJudge",
      "observerSigner",
      "semanticJudgeSigner",
      "cleanup",
      "pinnedObserverPublicKeysPem",
      "pinnedSemanticJudgePublicKeysPem",
      "pinnedCleanupPublicKeysPem",
    ],
    functionKeys: [],
    optionalFunctionKeys: ["now"],
  });
  assertClosedObject({
    value: input.controller,
    label: "controller",
    dataKeys: ["endpointOrigin", "controllerFamily"],
    functionKeys: ["execute"],
  });
  assertClosedObject({
    value: input.observer,
    label: "observer",
    dataKeys: ["endpointOrigin", "administrativeDomain"],
    functionKeys: ["beginObservation", "complete"],
  });
  assertClosedObject({
    value: input.semanticJudge,
    label: "semanticJudge",
    dataKeys: [],
    functionKeys: ["evaluate"],
  });
  assertClosedObject({
    value: input.observerSigner,
    label: "observerSigner",
    dataKeys: ["pin"],
    functionKeys: ["sign"],
  });
  assertClosedObject({
    value: input.semanticJudgeSigner,
    label: "semanticJudgeSigner",
    dataKeys: ["pin"],
    functionKeys: ["sign"],
  });
  assertClosedObject({
    value: input.cleanup,
    label: "cleanup",
    dataKeys: [
      "endpointOrigin",
      "administrativeDomain",
      "keyId",
      "publicKeyPem",
    ],
    functionKeys: ["cleanupAndSign"],
  });
  const contract = PROVIDER_CONTROLLER_BRIDGE_CONTRACTS[input.scenarioId];
  if (contract.operationKind !== input.operationKind) {
    fail("operation kind does not match the canonical scenario");
  }
  if (input.controller.controllerFamily !== contract.controllerFamily) {
    fail("deployed controller family does not match the canonical scenario");
  }
  requireHttpsOrigin(input.controller.endpointOrigin, "controller");
  requireHttpsOrigin(input.observer.endpointOrigin, "observer");
  if (input.observer.administrativeDomain.trim().length === 0) {
    fail("observer administrativeDomain is required");
  }
  if (input.observer.endpointOrigin === input.controller.endpointOrigin) {
    fail("independent observer and deployed controller endpoints must differ");
  }
  const independentSigners = preflightIndependentEvidenceSigners({
    observer: input.observerSigner.pin,
    judge: input.semanticJudgeSigner.pin,
  });
  const pinnedObserverIds = new Set(
    input.pinnedObserverPublicKeysPem.map((pin) => providerObserverKeyId(pin)),
  );
  const pinnedJudgeIds = new Set(
    input.pinnedSemanticJudgePublicKeysPem.map((pin) =>
      providerObserverKeyId(pin),
    ),
  );
  if (
    !pinnedObserverIds.has(independentSigners.observer.keyId) ||
    !pinnedJudgeIds.has(independentSigners.judge.keyId)
  ) {
    fail("remote evidence signer key is not in the orchestrator trust pins");
  }
  validateCleanupSignerIdentity(
    input.cleanup,
    input.pinnedCleanupPublicKeysPem,
    "cleanup",
  );
  if (input.cleanup.keyId !== independentSigners.observer.keyId) {
    fail("cleanup signer must equal the manifest-authorized observer signer");
  }

  let correlation: ProviderBridgeCorrelation | undefined;
  let session: ProviderObserverSigningSession | undefined;
  let run: CompletedControllerRun | undefined;
  let cleanupProof: SignedProviderCleanupProof | undefined;
  let cleanupProofTaken = false;

  const capabilities: ProviderControllerOperatorCapabilities = {
    observer: {
      async begin(context) {
        if (correlation !== undefined) fail("bridge instance cannot be reused");
        correlation = validateContext(context, contract);
        const started = await input.observer.beginObservation({
          correlation,
        });
        if (
          started.sessionId.trim().length === 0 ||
          started.correlationSha256 !==
            canonicalSha256(correlation, "providerBridge.correlation")
        ) {
          fail("independent observer returned an invalid session binding");
        }
        session = Object.freeze({ ...started });
        return {
          async complete({
            context: completionContext,
            ingress,
            trajectories,
          }) {
            const expected = validateContext(completionContext, contract);
            const activeCorrelation = correlation;
            if (
              activeCorrelation === undefined ||
              canonicalSha256(expected, "providerBridge.correlation") !==
                canonicalSha256(
                  activeCorrelation,
                  "providerBridge.correlation",
                ) ||
              run === undefined ||
              session === undefined ||
              ingress.runnerReport !== run.runnerReport ||
              trajectories.setSha256 !== run.trajectories.setSha256
            ) {
              fail(
                "observer completion does not match the executed controller run",
              );
            }
            const material = canonicalObserverMaterial(
              await input.observer.complete({
                correlation: activeCorrelation,
                session,
                rawControllerMaterial: run.rawControllerMaterial,
                rawControllerMaterialSha256: run.rawControllerMaterialSha256,
                runnerReport: run.runnerReport,
                runnerReportSha256: run.runnerReportSha256,
                runnerResultSha256: run.runnerResultSha256,
                trajectories: run.trajectories,
              }),
            );
            const evidence = await input.observerSigner.sign(
              buildObserverPayload({
                correlation: activeCorrelation,
                run,
                material,
                signedAtIso: bridgeNowIso(input),
              }),
            );
            if (
              evidence.keyId !== input.observerSigner.pin.keyId ||
              evidence.payload.runnerResultSha256 !== run.runnerResultSha256
            ) {
              fail(
                "observer signer returned an envelope for different runner material",
              );
            }
            assertEvidenceCorrelation(
              activeCorrelation,
              run.trajectories,
              evidence,
              undefined,
            );
            return evidence;
          },
        };
      },
    },
    ingress: {
      async execute(context) {
        if (
          correlation === undefined ||
          session === undefined ||
          run !== undefined
        ) {
          fail("controller execution requires one active observer session");
        }
        validateContext(context, contract);
        run = validateControllerRun(
          context,
          contract,
          await input.controller.execute({
            correlation,
            providerTarget: canonicalJsonValue(
              context.providerTarget,
              "providerBridge.providerTarget",
            ),
            operationInput: canonicalJsonValue(
              context.operationInput,
              "providerBridge.operationInput",
            ),
            failureProbes: context.failureProbes,
          }),
        );
        return { runnerReport: run.runnerReport };
      },
    },
    trajectories: {
      async verify({ context, ingress }) {
        validateContext(context, contract);
        if (run === undefined || ingress.runnerReport !== run.runnerReport) {
          fail("trajectory request does not match the executed controller run");
        }
        return run.trajectories;
      },
    },
    semanticJudge: {
      async judge({ context, ingress, trajectories, observerEvidence }) {
        validateContext(context, contract);
        if (
          correlation === undefined ||
          run === undefined ||
          ingress.runnerReport !== run.runnerReport ||
          trajectories.setSha256 !== run.trajectories.setSha256
        ) {
          fail("semantic judgment does not match the executed controller run");
        }
        assertEvidenceCorrelation(
          correlation,
          trajectories,
          observerEvidence,
          undefined,
        );
        const verdicts = await input.semanticJudge.evaluate({
          correlation,
          rawControllerMaterial: run.rawControllerMaterial,
          rawControllerMaterialSha256: run.rawControllerMaterialSha256,
          runnerReport: run.runnerReport,
          runnerReportSha256: run.runnerReportSha256,
          trajectories: run.trajectories,
          observerEvidence,
          observerEnvelopeSha256: canonicalSha256(
            observerEvidence,
            "providerBridge.observerEvidence",
          ),
        });
        const semantic = await input.semanticJudgeSigner.sign(
          buildSemanticPayload({
            context,
            correlation,
            run,
            verdicts,
            signedAtIso: bridgeNowIso(input),
          }),
        );
        if (semantic.keyId !== input.semanticJudgeSigner.pin.keyId) {
          fail("semantic judge returned an envelope from an unexpected key");
        }
        assertEvidenceCorrelation(
          correlation,
          trajectories,
          observerEvidence,
          semantic,
        );
        return semantic;
      },
    },
    cleanup: {
      async cleanup({ context, completedStages, artifact, failure }) {
        validateContext(context, contract);
        if (correlation === undefined || run === undefined) {
          fail(
            "cleanup cannot be proven because controller execution produced no cleanup scope",
          );
        }
        const proof = await input.cleanup.cleanupAndSign({
          correlation,
          cleanupScopeSha256: run.cleanupScopeSha256,
          rawControllerMaterialSha256: run.rawControllerMaterialSha256,
          ...(artifact === undefined
            ? {}
            : { qualificationArtifactSha256: artifact.artifactSha256 }),
          completedStages,
          failed: failure !== undefined,
        });
        cleanupProof = verifyProviderCleanupProof({
          proof,
          pinnedPublicKeysPem: input.pinnedCleanupPublicKeysPem,
          expected: {
            scenarioId: correlation.scenarioId,
            runId: correlation.runId,
            runNonce: correlation.runNonce,
            manifestSha256: correlation.manifestSha256,
            cleanupScopeSha256: run.cleanupScopeSha256,
            rawControllerMaterialSha256: run.rawControllerMaterialSha256,
            ...(artifact === undefined
              ? {}
              : { qualificationArtifactSha256: artifact.artifactSha256 }),
            scenarioEndedAtIso: run.trajectories.scenarioEndedAtIso,
            keyId: input.cleanup.keyId,
          },
          now: (input.now ?? (() => new Date()))(),
        });
      },
    },
  };
  return Object.freeze({
    capabilities: Object.freeze(capabilities),
    cleanupPublicKeyPem: input.cleanup.publicKeyPem,
    takeVerifiedCleanupProof(): SignedProviderCleanupProof {
      if (
        cleanupProof === undefined ||
        correlation === undefined ||
        run === undefined
      ) {
        fail("verified cleanup proof is unavailable before successful cleanup");
      }
      if (cleanupProofTaken)
        fail("verified cleanup proof was already consumed");
      if (cleanupProof.payload.qualificationArtifactSha256 === undefined) {
        fail("verified cleanup proof is not bound to a qualification artifact");
      }
      cleanupProofTaken = true;
      return cleanupProof;
    },
  });
}
