/**
 * Persists and advances one-shot sandbox replacement attempts on the primary.
 * Every callback is fenced by tenant, agent, activation generation, and the
 * byte-identical S0 locator. Ambiguous effects also hold an agent-wide fence;
 * no API expires, deletes, or reopens an attempt.
 */

import { Buffer } from "node:buffer";
import { ElizaError } from "@elizaos/core";
import { and, eq, or, sql } from "drizzle-orm";
import { isUniqueConstraintError } from "../../lib/utils/db-errors";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
  type AgentBackupRestoreLease,
  type AgentBackupRestoreOperation,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "../schemas/agent-backup-catalog";
import { agentActivationPublications } from "../schemas/agent-backup-restore-history";
import {
  AGENT_SANDBOX_REPLACEMENT_OPERATION_KINDS,
  type AgentSandboxReplacementAttempt,
  type AgentSandboxReplacementOperationKind,
  agentSandboxReplacementAttempts,
} from "../schemas/agent-sandbox-replacement-attempts";
import { agentSandboxBackups, agentSandboxes } from "../schemas/agent-sandboxes";
import { dockerNodes, PLACEABLE_NODE_STATE } from "../schemas/docker-nodes";
import { organizations } from "../schemas/organizations";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_REPLACEMENT_ATTEMPT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_FULL_CONTAINER_ID = /^[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ACTIVATION_TOKEN_CIPHERTEXT_BYTES = 16_384;
const MAX_UNSIGNED_INT64 = 18_446_744_073_709_551_615n;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;

export interface AgentSandboxReplacementAttemptReference {
  readonly attemptId: string;
  readonly organizationId: string;
  readonly agentId: string;
}

export interface AgentSandboxReplacementRestoreAuthority {
  readonly leaseId: string;
  readonly backupId: string;
  readonly restoreAttemptId: string;
  readonly ownerId: string;
  readonly fencingToken: string;
  readonly catalogEpoch: string;
  readonly copyRole: "primary" | "secondary";
  readonly operationId: string;
  readonly sourceActivationGeneration: string;
  readonly sourceLifecycleRevision: string;
  readonly expectedManifestSha256: string;
  readonly expiresAt: Date;
}

export interface StartAgentSandboxReplacementAttemptInput
  extends AgentSandboxReplacementAttemptReference {
  readonly operationKind: AgentSandboxReplacementOperationKind;
  readonly lifecycleRevision: string;
  readonly activationGeneration: string;
  readonly lifecycleJobId: string | null;
  readonly lifecycleExecutionGeneration: string | null;
  readonly restoreAuthority: AgentSandboxReplacementRestoreAuthority | null;
}

/**
 * Lifecycle authority consumed by the atomic activation-rotation/start gate.
 * Warm-pool provisioning intentionally remains outside this API because it has
 * no tenant lifecycle job or canonical sandbox owner at provider-call time.
 */
export interface AdmitAndStartAgentSandboxReplacementInput
  extends AgentSandboxReplacementAttemptReference {
  readonly operationKind: AgentSandboxReplacementOperationKind;
  readonly expectedLifecycleRevision: string;
  readonly targetActivationGeneration: string;
  readonly activationPurpose: "provision" | "wake";
  readonly activationTokenSha256: string;
  readonly activationTokenCiphertext: string;
  readonly lifecycleJobId: string | null;
  readonly lifecycleExecutionGeneration: string | null;
  readonly restoreAuthority: AgentSandboxReplacementRestoreAuthority | null;
}

/** Complete S0 callback locator; stage methods enforce their enrichment shape. */
export interface AgentSandboxReplacementLocatorInput {
  readonly replacementAttemptId: string;
  readonly sandboxId: string;
  readonly nodeId: string;
  readonly containerName: string;
  readonly nodeRecordId: string;
  readonly nodeIncarnation: string;
  readonly nodeHistoryId: string;
  readonly nodeHostname: string;
  readonly nodeSshPort: number;
  readonly nodeSshUser: string;
  readonly nodeHostKeyFingerprint: string;
  readonly replacementSecretCleanupVersion: 1;
  readonly allocationCounted: true;
  readonly vpnNodeName: string | null;
  readonly vpnRegistrationStartedAt: string | null;
  readonly previousVpnNodeId: string | null;
  readonly containerId: string | null;
  readonly vpnNodeId: string | null;
}

/** Exact pre-adoption owner that the sandbox CAS must retain for cleanup. */
export interface AgentSandboxReplacementPreviousPlacementInput {
  readonly sandboxId: string;
  readonly nodeId: string;
  readonly containerName: string;
  readonly allocationCounted: true;
}

export interface AgentSandboxReplacementPreviousPlacementAuthority
  extends AgentSandboxReplacementPreviousPlacementInput {
  readonly containerId: string;
  readonly nodeRecordId: string;
  readonly nodeIncarnation: string;
  readonly nodeHistoryId: string;
  readonly nodeHostname: string;
  readonly nodeSshPort: number;
  readonly nodeSshUser: string;
  readonly nodeHostKeyFingerprint: string;
}

/**
 * Canonical provider metadata committed with placement adoption. The status is
 * intentionally fixed to the non-routable provisioning state: readiness and
 * route publication remain a later, independently fenced transition.
 */
export interface AgentSandboxReplacementCanonicalPatchInput {
  readonly status: "provisioning";
  readonly bridgeUrl: string;
  readonly healthUrl: string;
  readonly lastHeartbeatAt: Date;
  readonly errorMessage: null;
  readonly bridgePort: number;
  readonly webUiPort: number;
  readonly headscaleIp: string | null;
  readonly dockerImage: string;
  readonly imageDigest: string | null;
  readonly previousDockerImage: string | null;
  readonly previousImageDigest: string | null;
}

/** Exact authority S2 must re-present when atomically adopting provider success. */
export interface CommitAgentSandboxReplacementLifecycleAdoptionInput
  extends StartAgentSandboxReplacementAttemptInput {
  readonly locator: AgentSandboxReplacementLocatorInput;
  /** NULL is valid only for a classified first provision with no restore. */
  readonly previousPlacement: AgentSandboxReplacementPreviousPlacementInput | null;
  readonly canonicalPatch: AgentSandboxReplacementCanonicalPatchInput;
  readonly providerReceiptDigest: string;
  readonly lifecycleReceiptDigest: string;
}

export interface AgentSandboxReplacementAttemptWriteResult {
  readonly attempt: Readonly<AgentSandboxReplacementAttempt>;
  readonly replayed: boolean;
}

export interface AdmitAndStartAgentSandboxReplacementResult {
  readonly startInput: Readonly<StartAgentSandboxReplacementAttemptInput>;
  readonly previousPlacement: Readonly<AgentSandboxReplacementPreviousPlacementAuthority> | null;
  readonly attempt: Readonly<AgentSandboxReplacementAttempt>;
}

export type AgentSandboxReplacementCapacityIntent =
  | { readonly kind: "standalone" }
  | {
      readonly kind: "restore_handoff";
      readonly restoreOperationId: string;
      readonly restoreClaimGeneration: string;
      readonly receiptDigest: string;
    };

interface ValidatedReference {
  attemptId: string;
  organizationId: string;
  agentId: string;
}

interface ValidatedRestoreAuthority {
  leaseId: string;
  backupId: string;
  restoreAttemptId: string;
  ownerId: string;
  fencingToken: string;
  catalogEpoch: bigint;
  copyRole: "primary" | "secondary";
  operationId: string;
  sourceActivationGeneration: string;
  sourceLifecycleRevision: bigint;
  expectedManifestSha256: string;
  expiresAt: Date;
}

interface ValidatedStart extends ValidatedReference {
  operationKind: AgentSandboxReplacementOperationKind;
  lifecycleRevision: bigint;
  activationGeneration: string;
  lifecycleJobId: string | null;
  lifecycleExecutionGeneration: string | null;
  restoreAuthority: ValidatedRestoreAuthority | null;
}

interface ValidatedAdmission extends ValidatedReference {
  operationKind: AgentSandboxReplacementOperationKind;
  expectedLifecycleRevision: bigint;
  targetActivationGeneration: string;
  activationPurpose: "provision" | "wake";
  activationTokenSha256: string;
  activationTokenCiphertext: string;
  lifecycleJobId: string | null;
  lifecycleExecutionGeneration: string | null;
  restoreAuthority: ValidatedRestoreAuthority | null;
}

interface ValidatedLocator {
  replacementAttemptId: string;
  sandboxId: string;
  nodeId: string;
  containerName: string;
  nodeRecordId: string;
  nodeIncarnation: string;
  nodeHistoryId: string;
  nodeHostname: string;
  nodeSshPort: number;
  nodeSshUser: string;
  nodeHostKeyFingerprint: string;
  replacementSecretCleanupVersion: 1;
  allocationCounted: true;
  vpnNodeName: string | null;
  vpnRegistrationStartedAt: Date | null;
  previousVpnNodeId: string | null;
  containerId: string | null;
  vpnNodeId: string | null;
}

interface ValidatedPreviousPlacement {
  sandboxId: string;
  nodeId: string;
  containerName: string;
  allocationCounted: true;
}

interface ValidatedCanonicalPatch {
  status: "provisioning";
  bridgeUrl: string;
  healthUrl: string;
  lastHeartbeatAt: Date;
  errorMessage: null;
  bridgePort: number;
  webUiPort: number;
  headscaleIp: string | null;
  dockerImage: string;
  imageDigest: string | null;
  previousDockerImage: string | null;
  previousImageDigest: string | null;
}

type ValidatedCapacityIntent =
  | { kind: "standalone" }
  | {
      kind: "restore_handoff";
      restoreOperationId: string;
      restoreClaimGeneration: string;
      receiptDigest: string;
    };

type LocatorStage = "intent" | "created" | "vpn" | "final";

function invalidInput(message: string, field?: string): ElizaError {
  return new ElizaError(message, {
    code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT",
    context: field ? { field } : undefined,
    severity: "fatal",
  });
}

function conflict(
  message: string,
  reference: Pick<ValidatedReference, "attemptId" | "organizationId" | "agentId">,
  state?: AgentSandboxReplacementAttempt["state"],
): ElizaError {
  return new ElizaError(message, {
    code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    context: {
      replacementAttemptId: reference.attemptId,
      organizationId: reference.organizationId,
      agentId: reference.agentId,
      state: state ?? null,
    },
    severity: "fatal",
  });
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidInput(`${field} must be an object`, field);
  }
  return value as Record<string, unknown>;
}

function requireCanonicalUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw invalidInput(`${field} must be a canonical lowercase UUID`, field);
  }
  return value;
}

function requireAttemptId(value: unknown, field: string): string {
  if (typeof value !== "string" || !CANONICAL_REPLACEMENT_ATTEMPT_ID.test(value)) {
    throw invalidInput(`${field} must be a canonical lowercase replacement UUID`, field);
  }
  return value;
}

function requireCanonicalInteger(value: unknown, field: string, maximum: bigint): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw invalidInput(`${field} must be a canonical unsigned decimal integer`, field);
  }
  const parsed = BigInt(value);
  if (parsed > maximum) {
    throw invalidInput(`${field} exceeds its database range`, field);
  }
  return parsed;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw invalidInput(`${field} must be a lowercase sha256 digest`, field);
  }
  return value;
}

function requireBoundedNonblankString(value: unknown, field: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw invalidInput(`${field} must contain 1-${maximumBytes} UTF-8 bytes`, field);
  }
  return value;
}

function requireOwnerId(value: unknown): string {
  const ownerId = requireBoundedNonblankString(value, "restoreAuthority.ownerId", 255);
  if (ownerId !== ownerId.trim() || /[\u0000-\u001f\u007f]/.test(ownerId)) {
    throw invalidInput(
      "restoreAuthority.ownerId must be trimmed and contain no control characters",
      "restoreAuthority.ownerId",
    );
  }
  return ownerId;
}

function requireNullableString(value: unknown, field: string, maximumBytes: number): string | null {
  if (value === null) return null;
  return requireBoundedNonblankString(value, field, maximumBytes);
}

function requireHeadscaleNodeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw invalidInput(`${field} must be a positive canonical uint64`, field);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UNSIGNED_INT64) {
    throw invalidInput(`${field} must fit uint64`, field);
  }
  return value;
}

function requireNullableHeadscaleNodeId(value: unknown, field: string): string | null {
  return value === null ? null : requireHeadscaleNodeId(value, field);
}

function requireNullableIsoTimestamp(value: unknown, field: string): Date | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw invalidInput(`${field} must be an ISO timestamp or null`, field);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || value !== parsed.toISOString()) {
    throw invalidInput(`${field} must be a canonical ISO timestamp`, field);
  }
  return parsed;
}

function validateReference(input: unknown): ValidatedReference {
  const record = requireObject(input, "input");
  return {
    attemptId: requireAttemptId(record.attemptId, "attemptId"),
    organizationId: requireCanonicalUuid(record.organizationId, "organizationId"),
    agentId: requireCanonicalUuid(record.agentId, "agentId"),
  };
}

function validateRestoreAuthority(value: unknown): ValidatedRestoreAuthority | null {
  if (value === null) return null;
  const authority = requireObject(value, "restoreAuthority");
  if (authority.copyRole !== "primary" && authority.copyRole !== "secondary") {
    throw invalidInput(
      "restoreAuthority.copyRole must be primary or secondary",
      "restoreAuthority.copyRole",
    );
  }
  if (!(authority.expiresAt instanceof Date) || !Number.isFinite(authority.expiresAt.getTime())) {
    throw invalidInput(
      "restoreAuthority.expiresAt must be a valid Date",
      "restoreAuthority.expiresAt",
    );
  }
  return {
    leaseId: requireCanonicalUuid(authority.leaseId, "restoreAuthority.leaseId"),
    backupId: requireCanonicalUuid(authority.backupId, "restoreAuthority.backupId"),
    restoreAttemptId: requireCanonicalUuid(
      authority.restoreAttemptId,
      "restoreAuthority.restoreAttemptId",
    ),
    ownerId: requireOwnerId(authority.ownerId),
    fencingToken: requireCanonicalUuid(authority.fencingToken, "restoreAuthority.fencingToken"),
    catalogEpoch: requireCanonicalInteger(
      authority.catalogEpoch,
      "restoreAuthority.catalogEpoch",
      MAX_SIGNED_INT64,
    ),
    copyRole: authority.copyRole,
    operationId: requireCanonicalUuid(authority.operationId, "restoreAuthority.operationId"),
    sourceActivationGeneration: requireCanonicalUuid(
      authority.sourceActivationGeneration,
      "restoreAuthority.sourceActivationGeneration",
    ),
    sourceLifecycleRevision: requireCanonicalInteger(
      authority.sourceLifecycleRevision,
      "restoreAuthority.sourceLifecycleRevision",
      MAX_UNSIGNED_INT64,
    ),
    expectedManifestSha256: requireSha256(
      authority.expectedManifestSha256,
      "restoreAuthority.expectedManifestSha256",
    ),
    expiresAt: new Date(authority.expiresAt.getTime()),
  };
}

function validateStart(input: unknown): ValidatedStart {
  const record = requireObject(input, "input");
  const reference = validateReference(record);
  if (
    typeof record.operationKind !== "string" ||
    !AGENT_SANDBOX_REPLACEMENT_OPERATION_KINDS.some(
      (operationKind) => operationKind === record.operationKind,
    )
  ) {
    throw invalidInput("operationKind must be provision, upgrade, or downgrade", "operationKind");
  }
  const lifecycleJobId =
    record.lifecycleJobId === null
      ? null
      : requireCanonicalUuid(record.lifecycleJobId, "lifecycleJobId");
  const lifecycleExecutionGeneration =
    record.lifecycleExecutionGeneration === null
      ? null
      : requireCanonicalUuid(record.lifecycleExecutionGeneration, "lifecycleExecutionGeneration");
  if ((lifecycleJobId === null) !== (lifecycleExecutionGeneration === null)) {
    throw invalidInput(
      "lifecycleJobId and lifecycleExecutionGeneration must be supplied together",
      "lifecycleJobId",
    );
  }
  const activationGeneration = requireCanonicalUuid(
    record.activationGeneration,
    "activationGeneration",
  );
  const restoreAuthority = validateRestoreAuthority(record.restoreAuthority);
  if (restoreAuthority !== null && activationGeneration !== restoreAuthority.restoreAttemptId) {
    throw invalidInput(
      "restore activationGeneration must equal restoreAuthority.restoreAttemptId",
      "activationGeneration",
    );
  }
  return {
    ...reference,
    operationKind: record.operationKind as AgentSandboxReplacementOperationKind,
    lifecycleRevision: requireCanonicalInteger(
      record.lifecycleRevision,
      "lifecycleRevision",
      MAX_UNSIGNED_INT64,
    ),
    activationGeneration,
    lifecycleJobId,
    lifecycleExecutionGeneration,
    restoreAuthority,
  };
}

function validateAdmission(input: unknown): ValidatedAdmission {
  const record = requireObject(input, "input");
  const reference = validateReference(record);
  if (
    typeof record.operationKind !== "string" ||
    !AGENT_SANDBOX_REPLACEMENT_OPERATION_KINDS.some(
      (operationKind) => operationKind === record.operationKind,
    )
  ) {
    throw invalidInput("operationKind must be provision, upgrade, or downgrade", "operationKind");
  }
  if (record.activationPurpose !== "provision" && record.activationPurpose !== "wake") {
    throw invalidInput("activationPurpose must be provision or wake", "activationPurpose");
  }
  const lifecycleJobId =
    record.lifecycleJobId === null
      ? null
      : requireCanonicalUuid(record.lifecycleJobId, "lifecycleJobId");
  const lifecycleExecutionGeneration =
    record.lifecycleExecutionGeneration === null
      ? null
      : requireCanonicalUuid(record.lifecycleExecutionGeneration, "lifecycleExecutionGeneration");
  if ((lifecycleJobId === null) !== (lifecycleExecutionGeneration === null)) {
    throw invalidInput(
      "lifecycleJobId and lifecycleExecutionGeneration must be supplied together",
      "lifecycleJobId",
    );
  }
  const activationTokenCiphertext = requireBoundedNonblankString(
    record.activationTokenCiphertext,
    "activationTokenCiphertext",
    MAX_ACTIVATION_TOKEN_CIPHERTEXT_BYTES,
  );
  if (activationTokenCiphertext.includes("\0")) {
    throw invalidInput(
      "activationTokenCiphertext must not contain NUL",
      "activationTokenCiphertext",
    );
  }
  const targetActivationGeneration = requireCanonicalUuid(
    record.targetActivationGeneration,
    "targetActivationGeneration",
  );
  const restoreAuthority = validateRestoreAuthority(record.restoreAuthority);
  if (
    restoreAuthority !== null &&
    targetActivationGeneration !== restoreAuthority.restoreAttemptId
  ) {
    throw invalidInput(
      "restore targetActivationGeneration must equal restoreAuthority.restoreAttemptId",
      "targetActivationGeneration",
    );
  }
  return {
    ...reference,
    operationKind: record.operationKind as AgentSandboxReplacementOperationKind,
    expectedLifecycleRevision: requireCanonicalInteger(
      record.expectedLifecycleRevision,
      "expectedLifecycleRevision",
      MAX_SIGNED_INT64 - 1n,
    ),
    targetActivationGeneration,
    activationPurpose: record.activationPurpose,
    activationTokenSha256: requireSha256(record.activationTokenSha256, "activationTokenSha256"),
    activationTokenCiphertext,
    lifecycleJobId,
    lifecycleExecutionGeneration,
    restoreAuthority,
  };
}

function validateLocator(
  input: unknown,
  reference: ValidatedReference,
  stage: LocatorStage,
): ValidatedLocator {
  const locator = requireObject(input, "locator");
  const replacementAttemptId = requireAttemptId(
    locator.replacementAttemptId,
    "locator.replacementAttemptId",
  );
  if (replacementAttemptId !== reference.attemptId) {
    throw invalidInput(
      "locator.replacementAttemptId does not match attemptId",
      "locator.replacementAttemptId",
    );
  }
  const sandboxId = requireBoundedNonblankString(locator.sandboxId, "locator.sandboxId", 128);
  const containerName = requireBoundedNonblankString(
    locator.containerName,
    "locator.containerName",
    128,
  );
  const expectedContainerName = `agent-${reference.agentId}`;
  if (
    sandboxId !== containerName ||
    containerName !== expectedContainerName ||
    !/^agent-[a-zA-Z0-9_-]+$/.test(containerName)
  ) {
    throw invalidInput(
      "locator sandbox and container names must equal the deterministic agent container",
      "locator.containerName",
    );
  }
  if (locator.replacementSecretCleanupVersion !== 1) {
    throw invalidInput(
      "locator.replacementSecretCleanupVersion must be 1",
      "locator.replacementSecretCleanupVersion",
    );
  }
  if (locator.allocationCounted !== true) {
    throw invalidInput("locator.allocationCounted must be true", "locator.allocationCounted");
  }
  if (
    typeof locator.nodeSshPort !== "number" ||
    !Number.isSafeInteger(locator.nodeSshPort) ||
    locator.nodeSshPort < 1 ||
    locator.nodeSshPort > 65_535
  ) {
    throw invalidInput(
      "locator.nodeSshPort must be an integer from 1 through 65535",
      "locator.nodeSshPort",
    );
  }
  const vpnNodeName = requireNullableString(locator.vpnNodeName, "locator.vpnNodeName", 255);
  const vpnRegistrationStartedAt = requireNullableIsoTimestamp(
    locator.vpnRegistrationStartedAt,
    "locator.vpnRegistrationStartedAt",
  );
  if ((vpnNodeName === null) !== (vpnRegistrationStartedAt === null)) {
    throw invalidInput(
      "locator VPN name and registration timestamp must be supplied together",
      "locator.vpnNodeName",
    );
  }
  const previousVpnNodeId = requireNullableHeadscaleNodeId(
    locator.previousVpnNodeId,
    "locator.previousVpnNodeId",
  );
  if (previousVpnNodeId !== null && vpnNodeName === null) {
    throw invalidInput(
      "locator.previousVpnNodeId requires VPN registration correlation",
      "locator.previousVpnNodeId",
    );
  }
  const containerId =
    locator.containerId === null
      ? null
      : typeof locator.containerId === "string" &&
          CANONICAL_FULL_CONTAINER_ID.test(locator.containerId)
        ? locator.containerId
        : (() => {
            throw invalidInput(
              "locator.containerId must be a canonical 64-character Docker ID or null",
              "locator.containerId",
            );
          })();
  const vpnNodeId = requireNullableHeadscaleNodeId(locator.vpnNodeId, "locator.vpnNodeId");
  if (
    vpnNodeId !== null &&
    (containerId === null || vpnNodeName === null || vpnNodeId === previousVpnNodeId)
  ) {
    throw invalidInput(
      "locator.vpnNodeId requires the created container and distinct VPN correlation",
      "locator.vpnNodeId",
    );
  }
  if (
    (stage === "intent" && (containerId !== null || vpnNodeId !== null)) ||
    ((stage === "created" || stage === "vpn" || stage === "final") && containerId === null) ||
    (stage === "created" && vpnNodeId !== null) ||
    (stage === "vpn" && vpnNodeId === null) ||
    (stage === "final" && vpnNodeName !== null && vpnNodeId === null)
  ) {
    throw invalidInput(`locator enrichment does not match the ${stage} stage`, "locator");
  }
  return {
    replacementAttemptId,
    sandboxId,
    nodeId: requireBoundedNonblankString(locator.nodeId, "locator.nodeId", 255),
    containerName,
    nodeRecordId: requireCanonicalUuid(locator.nodeRecordId, "locator.nodeRecordId"),
    nodeIncarnation: requireCanonicalUuid(locator.nodeIncarnation, "locator.nodeIncarnation"),
    nodeHistoryId: requireCanonicalUuid(locator.nodeHistoryId, "locator.nodeHistoryId"),
    nodeHostname: requireBoundedNonblankString(locator.nodeHostname, "locator.nodeHostname", 255),
    nodeSshPort: locator.nodeSshPort,
    nodeSshUser: requireBoundedNonblankString(locator.nodeSshUser, "locator.nodeSshUser", 255),
    nodeHostKeyFingerprint: requireBoundedNonblankString(
      locator.nodeHostKeyFingerprint,
      "locator.nodeHostKeyFingerprint",
      1024,
    ),
    replacementSecretCleanupVersion: 1,
    allocationCounted: true,
    vpnNodeName,
    vpnRegistrationStartedAt,
    previousVpnNodeId,
    containerId,
    vpnNodeId,
  };
}

function validatePreviousPlacement(input: unknown): ValidatedPreviousPlacement | null {
  if (input === null) return null;
  const placement = requireObject(input, "previousPlacement");
  if (placement.allocationCounted !== true) {
    throw invalidInput(
      "previousPlacement.allocationCounted must be true",
      "previousPlacement.allocationCounted",
    );
  }
  return {
    sandboxId: requireBoundedNonblankString(
      placement.sandboxId,
      "previousPlacement.sandboxId",
      128,
    ),
    nodeId: requireBoundedNonblankString(placement.nodeId, "previousPlacement.nodeId", 255),
    containerName: requireBoundedNonblankString(
      placement.containerName,
      "previousPlacement.containerName",
      128,
    ),
    allocationCounted: true,
  };
}

function requirePort(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw invalidInput(`${field} must be an integer from 1 through 65535`, field);
  }
  return value;
}

function requireValidDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw invalidInput(`${field} must be a valid Date`, field);
  }
  return new Date(value.getTime());
}

function requireNullableImageDigest(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw invalidInput(`${field} must be a lowercase sha256 image digest or null`, field);
  }
  return value;
}

function validateCanonicalPatch(input: unknown): ValidatedCanonicalPatch {
  const patch = requireObject(input, "canonicalPatch");
  if (patch.status !== "provisioning") {
    throw invalidInput(
      "canonicalPatch.status must remain non-routable provisioning",
      "canonicalPatch.status",
    );
  }
  if (patch.errorMessage !== null) {
    throw invalidInput("canonicalPatch.errorMessage must be null", "canonicalPatch.errorMessage");
  }
  const previousDockerImage = requireNullableString(
    patch.previousDockerImage,
    "canonicalPatch.previousDockerImage",
    2048,
  );
  const previousImageDigest = requireNullableImageDigest(
    patch.previousImageDigest,
    "canonicalPatch.previousImageDigest",
  );
  if ((previousDockerImage === null) !== (previousImageDigest === null)) {
    throw invalidInput(
      "canonicalPatch previous image reference and digest must be supplied together",
      "canonicalPatch.previousDockerImage",
    );
  }
  return {
    status: "provisioning",
    bridgeUrl: requireBoundedNonblankString(patch.bridgeUrl, "canonicalPatch.bridgeUrl", 4096),
    healthUrl: requireBoundedNonblankString(patch.healthUrl, "canonicalPatch.healthUrl", 4096),
    lastHeartbeatAt: requireValidDate(patch.lastHeartbeatAt, "canonicalPatch.lastHeartbeatAt"),
    errorMessage: null,
    bridgePort: requirePort(patch.bridgePort, "canonicalPatch.bridgePort"),
    webUiPort: requirePort(patch.webUiPort, "canonicalPatch.webUiPort"),
    headscaleIp: requireNullableString(patch.headscaleIp, "canonicalPatch.headscaleIp", 255),
    dockerImage: requireBoundedNonblankString(
      patch.dockerImage,
      "canonicalPatch.dockerImage",
      2048,
    ),
    imageDigest: requireNullableImageDigest(patch.imageDigest, "canonicalPatch.imageDigest"),
    previousDockerImage,
    previousImageDigest,
  };
}

function validateCapacityIntent(input: unknown): ValidatedCapacityIntent {
  const record = requireObject(input, "capacityIntent");
  if (record.kind === "standalone") {
    return { kind: "standalone" };
  }
  if (record.kind !== "restore_handoff") {
    throw invalidInput(
      "capacityIntent.kind must be standalone or restore_handoff",
      "capacityIntent.kind",
    );
  }
  return {
    kind: "restore_handoff",
    restoreOperationId: requireCanonicalUuid(
      record.restoreOperationId,
      "capacityIntent.restoreOperationId",
    ),
    restoreClaimGeneration: requireCanonicalUuid(
      record.restoreClaimGeneration,
      "capacityIntent.restoreClaimGeneration",
    ),
    receiptDigest: requireSha256(record.receiptDigest, "capacityIntent.receiptDigest"),
  };
}

async function lockAttempt(
  tx: DbTransaction,
  reference: ValidatedReference,
): Promise<AgentSandboxReplacementAttempt> {
  const [attempt] = await tx
    .select()
    .from(agentSandboxReplacementAttempts)
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, reference.attemptId),
        eq(agentSandboxReplacementAttempts.organization_id, reference.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, reference.agentId),
      ),
    )
    .for("update")
    .limit(1);
  if (!attempt) {
    throw conflict("Replacement attempt authority is missing", reference);
  }
  return attempt;
}

function isTerminal(attempt: AgentSandboxReplacementAttempt): boolean {
  return attempt.state === "lifecycle_committed" || attempt.state === "cleanup_proven";
}

function assertCallbackStageOpen(
  attempt: AgentSandboxReplacementAttempt,
  reference: ValidatedReference,
): void {
  if (isTerminal(attempt)) {
    throw conflict(
      "Terminal replacement attempt cannot accept provider callbacks",
      reference,
      attempt.state,
    );
  }
}

function hasLocator(attempt: AgentSandboxReplacementAttempt): boolean {
  return attempt.locator_recorded_at !== null;
}

function sameNullableDate(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

function assertLocatorCoreMatches(
  attempt: AgentSandboxReplacementAttempt,
  locator: ValidatedLocator,
  reference: ValidatedReference,
): void {
  if (
    !hasLocator(attempt) ||
    attempt.locator_sandbox_id !== locator.sandboxId ||
    attempt.locator_node_id !== locator.nodeId ||
    attempt.locator_container_name !== locator.containerName ||
    attempt.locator_node_record_id !== locator.nodeRecordId ||
    attempt.locator_node_incarnation !== locator.nodeIncarnation ||
    attempt.locator_node_history_id !== locator.nodeHistoryId ||
    attempt.locator_node_hostname !== locator.nodeHostname ||
    attempt.locator_node_ssh_port !== locator.nodeSshPort ||
    attempt.locator_node_ssh_user !== locator.nodeSshUser ||
    attempt.locator_node_host_key_fingerprint !== locator.nodeHostKeyFingerprint ||
    attempt.locator_secret_cleanup_version !== locator.replacementSecretCleanupVersion ||
    attempt.locator_allocation_counted !== locator.allocationCounted ||
    attempt.locator_vpn_node_name !== locator.vpnNodeName ||
    !sameNullableDate(
      attempt.locator_vpn_registration_started_at,
      locator.vpnRegistrationStartedAt,
    ) ||
    attempt.locator_previous_vpn_node_id !== locator.previousVpnNodeId
  ) {
    throw conflict(
      "Replacement locator replay conflicts with immutable authority",
      reference,
      attempt.state,
    );
  }
}

function assertContainerMatches(
  attempt: AgentSandboxReplacementAttempt,
  containerId: string,
  reference: ValidatedReference,
): void {
  if (attempt.locator_container_id !== containerId) {
    throw conflict(
      "Replacement Docker enrichment conflicts with immutable authority",
      reference,
      attempt.state,
    );
  }
}

function assertVpnMatches(
  attempt: AgentSandboxReplacementAttempt,
  vpnNodeId: string | null,
  reference: ValidatedReference,
): void {
  if (attempt.locator_vpn_node_id !== vpnNodeId) {
    throw conflict(
      "Replacement VPN enrichment conflicts with immutable authority",
      reference,
      attempt.state,
    );
  }
}

function assertStartAuthorityMatches(
  attempt: AgentSandboxReplacementAttempt,
  expected: ValidatedStart,
): void {
  const restore = expected.restoreAuthority;
  if (
    attempt.operation_kind !== expected.operationKind ||
    attempt.lifecycle_revision !== expected.lifecycleRevision ||
    attempt.activation_generation !== expected.activationGeneration ||
    attempt.lifecycle_job_id !== expected.lifecycleJobId ||
    attempt.lifecycle_execution_generation !== expected.lifecycleExecutionGeneration ||
    attempt.restore_lease_id !== (restore?.leaseId ?? null) ||
    attempt.restore_backup_id !== (restore?.backupId ?? null) ||
    attempt.restore_attempt_id !== (restore?.restoreAttemptId ?? null) ||
    attempt.restore_lease_owner_id !== (restore?.ownerId ?? null) ||
    attempt.restore_lease_generation !== (restore?.fencingToken ?? null) ||
    attempt.restore_catalog_epoch !== (restore?.catalogEpoch ?? null) ||
    attempt.restore_copy_role !== (restore?.copyRole ?? null) ||
    attempt.restore_operation_id !== (restore?.operationId ?? null) ||
    attempt.restore_source_activation_generation !==
      (restore?.sourceActivationGeneration ?? null) ||
    attempt.restore_source_lifecycle_revision !== (restore?.sourceLifecycleRevision ?? null) ||
    attempt.restore_manifest_sha256 !== (restore?.expectedManifestSha256 ?? null) ||
    !sameNullableDate(attempt.restore_lease_expires_at, restore?.expiresAt ?? null)
  ) {
    throw conflict(
      "Lifecycle adoption authority conflicts with the replacement attempt",
      expected,
      attempt.state,
    );
  }
}

function frozenResult(
  attempt: AgentSandboxReplacementAttempt,
  replayed: boolean,
): AgentSandboxReplacementAttemptWriteResult {
  return Object.freeze({ attempt: Object.freeze(attempt), replayed });
}

interface LockedAgentSandboxAuthority {
  id: string;
  organizationId: string;
  lifecycleRevision: string;
  activationGeneration: string | null;
  activationPreviousGeneration: string | null;
  activationLifecycleRevision: bigint | null;
  activationPurpose: string | null;
  activationPhase: string | null;
  activationBackupId: string | null;
  activationBackupHash: string | null;
  activationReceipt: unknown | null;
  activationReceiptHash: string | null;
  activationContainerId: string | null;
  activationNodeId: string | null;
  activationImageDigest: string | null;
  activationTokenHash: string | null;
  activationTokenCiphertext: string | null;
  activationBootId: string | null;
  activationAuthorityPublishedAt: Date | null;
  activationFundingRevision: bigint | null;
  activationDispatchedAt: Date | null;
  activationCompletedAt: Date | null;
  activationConsentLifecycleRevision: bigint | null;
  activationConsentHeadBackupId: string | null;
  activationConsentHeadBackupHash: string | null;
  lifecycleJobId: string | null;
  lifecycleExecutionGeneration: string | null;
  status: string;
  deletedAt: Date | null;
  deletionAttemptId: string | null;
  deletionAllocationCounted: boolean | null;
  sandboxId: string | null;
  nodeId: string | null;
  containerName: string | null;
  bridgeUrl: string | null;
  healthUrl: string | null;
  lastHeartbeatAt: Date | null;
  errorMessage: string | null;
  bridgePort: number | null;
  webUiPort: number | null;
  headscaleIp: string | null;
  dockerImage: string | null;
  imageDigest: string | null;
  previousDockerImage: string | null;
  previousImageDigest: string | null;
  cleanupSandboxId: string | null;
  cleanupNodeId: string | null;
  cleanupNodeRecordId: string | null;
  cleanupNodeIncarnation: string | null;
  cleanupNodeHistoryId: string | null;
  cleanupNodeHostname: string | null;
  cleanupNodeSshPort: number | null;
  cleanupNodeSshUser: string | null;
  cleanupNodeHostKeyFingerprint: string | null;
  cleanupSecretCleanupVersion: number | null;
  cleanupContainerName: string | null;
  cleanupAttemptId: string | null;
  cleanupContainerId: string | null;
  cleanupVpnNodeId: string | null;
  cleanupVpnNodeName: string | null;
  cleanupPreservedVpnNodeId: string | null;
  cleanupVpnRegistrationStartedAt: Date | null;
  cleanupAllocationCounted: boolean | null;
  cleanupCreatedAt: Date | null;
}

async function lockAgentSandboxAuthority(
  tx: DbTransaction,
  reference: ValidatedReference,
): Promise<LockedAgentSandboxAuthority> {
  const [sandbox] = await tx
    .select({
      id: agentSandboxes.id,
      organizationId: agentSandboxes.organization_id,
      lifecycleRevision: sql<string>`${agentSandboxes.lifecycle_revision}::text`,
      activationGeneration: agentSandboxes.activation_generation,
      activationPreviousGeneration: agentSandboxes.activation_previous_generation,
      activationLifecycleRevision: agentSandboxes.activation_lifecycle_revision,
      activationPurpose: agentSandboxes.activation_purpose,
      activationPhase: agentSandboxes.activation_phase,
      activationBackupId: agentSandboxes.activation_backup_id,
      activationBackupHash: agentSandboxes.activation_backup_hash,
      activationReceipt: agentSandboxes.activation_receipt,
      activationReceiptHash: agentSandboxes.activation_receipt_hash,
      activationContainerId: agentSandboxes.activation_container_id,
      activationNodeId: agentSandboxes.activation_node_id,
      activationImageDigest: agentSandboxes.activation_image_digest,
      activationTokenHash: agentSandboxes.activation_token_hash,
      activationTokenCiphertext: agentSandboxes.activation_token_ciphertext,
      activationBootId: agentSandboxes.activation_boot_id,
      activationAuthorityPublishedAt: agentSandboxes.activation_authority_published_at,
      activationFundingRevision: agentSandboxes.activation_funding_revision,
      activationDispatchedAt: agentSandboxes.activation_dispatched_at,
      activationCompletedAt: agentSandboxes.activation_completed_at,
      activationConsentLifecycleRevision: agentSandboxes.activation_consent_lifecycle_revision,
      activationConsentHeadBackupId: agentSandboxes.activation_consent_head_backup_id,
      activationConsentHeadBackupHash: agentSandboxes.activation_consent_head_backup_hash,
      lifecycleJobId: agentSandboxes.lifecycle_job_id,
      lifecycleExecutionGeneration: agentSandboxes.lifecycle_execution_generation,
      status: agentSandboxes.status,
      deletedAt: agentSandboxes.deleted_at,
      deletionAttemptId: agentSandboxes.deletion_attempt_id,
      deletionAllocationCounted: agentSandboxes.deletion_allocation_counted,
      sandboxId: agentSandboxes.sandbox_id,
      nodeId: agentSandboxes.node_id,
      containerName: agentSandboxes.container_name,
      bridgeUrl: agentSandboxes.bridge_url,
      healthUrl: agentSandboxes.health_url,
      lastHeartbeatAt: agentSandboxes.last_heartbeat_at,
      errorMessage: agentSandboxes.error_message,
      bridgePort: agentSandboxes.bridge_port,
      webUiPort: agentSandboxes.web_ui_port,
      headscaleIp: agentSandboxes.headscale_ip,
      dockerImage: agentSandboxes.docker_image,
      imageDigest: agentSandboxes.image_digest,
      previousDockerImage: agentSandboxes.previous_docker_image,
      previousImageDigest: agentSandboxes.previous_image_digest,
      cleanupSandboxId: agentSandboxes.replacement_cleanup_sandbox_id,
      cleanupNodeId: agentSandboxes.replacement_cleanup_node_id,
      cleanupNodeRecordId: agentSandboxes.replacement_cleanup_node_record_id,
      cleanupNodeIncarnation: agentSandboxes.replacement_cleanup_node_incarnation,
      cleanupNodeHistoryId: agentSandboxes.replacement_cleanup_node_history_id,
      cleanupNodeHostname: agentSandboxes.replacement_cleanup_node_hostname,
      cleanupNodeSshPort: agentSandboxes.replacement_cleanup_node_ssh_port,
      cleanupNodeSshUser: agentSandboxes.replacement_cleanup_node_ssh_user,
      cleanupNodeHostKeyFingerprint: agentSandboxes.replacement_cleanup_node_host_key_fingerprint,
      cleanupSecretCleanupVersion: agentSandboxes.replacement_cleanup_secret_cleanup_version,
      cleanupContainerName: agentSandboxes.replacement_cleanup_container_name,
      cleanupAttemptId: agentSandboxes.replacement_cleanup_attempt_id,
      cleanupContainerId: agentSandboxes.replacement_cleanup_container_id,
      cleanupVpnNodeId: agentSandboxes.replacement_cleanup_vpn_node_id,
      cleanupVpnNodeName: agentSandboxes.replacement_cleanup_vpn_node_name,
      cleanupPreservedVpnNodeId: agentSandboxes.replacement_cleanup_preserved_vpn_node_id,
      cleanupVpnRegistrationStartedAt:
        agentSandboxes.replacement_cleanup_vpn_registration_started_at,
      cleanupAllocationCounted: agentSandboxes.replacement_cleanup_allocation_counted,
      cleanupCreatedAt: agentSandboxes.replacement_cleanup_created_at,
    })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, reference.agentId),
        eq(agentSandboxes.organization_id, reference.organizationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!sandbox) {
    throw conflict("Agent sandbox tenant authority is missing", reference);
  }
  return sandbox;
}

function assertAgentSandboxAuthorityMatches(
  sandbox: LockedAgentSandboxAuthority,
  expected: ValidatedStart,
  allowAdvancedLifecycleRevision = false,
): void {
  const lifecycleRevision = BigInt(sandbox.lifecycleRevision);
  if (
    sandbox.id !== expected.agentId ||
    sandbox.organizationId !== expected.organizationId ||
    (allowAdvancedLifecycleRevision
      ? lifecycleRevision < expected.lifecycleRevision
      : lifecycleRevision !== expected.lifecycleRevision) ||
    sandbox.activationGeneration !== expected.activationGeneration ||
    sandbox.activationLifecycleRevision !== expected.lifecycleRevision ||
    sandbox.activationPurpose === null ||
    (expected.restoreAuthority === null
      ? sandbox.activationPurpose !== "provision" && sandbox.activationPurpose !== "wake"
      : sandbox.activationPurpose !== "restore" ||
        sandbox.activationGeneration !== expected.restoreAuthority.restoreAttemptId) ||
    sandbox.activationPhase === null ||
    sandbox.activationPhase === "active" ||
    sandbox.activationPhase === "blocked" ||
    sandbox.activationTokenHash === null ||
    !SHA256.test(sandbox.activationTokenHash) ||
    sandbox.activationTokenCiphertext === null ||
    Buffer.byteLength(sandbox.activationTokenCiphertext, "utf8") < 1 ||
    Buffer.byteLength(sandbox.activationTokenCiphertext, "utf8") >
      MAX_ACTIVATION_TOKEN_CIPHERTEXT_BYTES ||
    sandbox.activationTokenCiphertext.includes("\0") ||
    sandbox.deletedAt !== null ||
    (expected.restoreAuthority !== null &&
      (sandbox.activationBackupId !== expected.restoreAuthority.backupId ||
        sandbox.activationBackupHash !== expected.restoreAuthority.expectedManifestSha256)) ||
    sandbox.lifecycleJobId !== expected.lifecycleJobId ||
    sandbox.lifecycleExecutionGeneration !== expected.lifecycleExecutionGeneration
  ) {
    throw conflict("Agent sandbox lifecycle authority does not match", expected);
  }
}

function hasAnyReplacementCleanupAuthority(sandbox: LockedAgentSandboxAuthority): boolean {
  return (
    sandbox.cleanupSandboxId !== null ||
    sandbox.cleanupNodeId !== null ||
    sandbox.cleanupNodeRecordId !== null ||
    sandbox.cleanupNodeIncarnation !== null ||
    sandbox.cleanupNodeHistoryId !== null ||
    sandbox.cleanupNodeHostname !== null ||
    sandbox.cleanupNodeSshPort !== null ||
    sandbox.cleanupNodeSshUser !== null ||
    sandbox.cleanupNodeHostKeyFingerprint !== null ||
    sandbox.cleanupSecretCleanupVersion !== null ||
    sandbox.cleanupContainerName !== null ||
    sandbox.cleanupAttemptId !== null ||
    sandbox.cleanupContainerId !== null ||
    sandbox.cleanupVpnNodeId !== null ||
    sandbox.cleanupVpnNodeName !== null ||
    sandbox.cleanupPreservedVpnNodeId !== null ||
    sandbox.cleanupVpnRegistrationStartedAt !== null ||
    sandbox.cleanupAllocationCounted !== null ||
    sandbox.cleanupCreatedAt !== null
  );
}

function candidateCleanupFenceMatches(
  sandbox: LockedAgentSandboxAuthority,
  attempt: AgentSandboxReplacementAttempt,
  locator: ValidatedLocator,
): boolean {
  return (
    sandbox.cleanupSandboxId === locator.sandboxId &&
    sandbox.cleanupNodeId === locator.nodeId &&
    sandbox.cleanupNodeRecordId === locator.nodeRecordId &&
    sandbox.cleanupNodeIncarnation === locator.nodeIncarnation &&
    sandbox.cleanupNodeHistoryId === locator.nodeHistoryId &&
    sandbox.cleanupNodeHostname === locator.nodeHostname &&
    sandbox.cleanupNodeSshPort === locator.nodeSshPort &&
    sandbox.cleanupNodeSshUser === locator.nodeSshUser &&
    sandbox.cleanupNodeHostKeyFingerprint === locator.nodeHostKeyFingerprint &&
    sandbox.cleanupSecretCleanupVersion === 1 &&
    sandbox.cleanupContainerName === locator.containerName &&
    sandbox.cleanupAttemptId === attempt.id &&
    sandbox.cleanupContainerId === locator.containerId &&
    sandbox.cleanupVpnNodeId === locator.vpnNodeId &&
    sandbox.cleanupVpnNodeName === locator.vpnNodeName &&
    sandbox.cleanupPreservedVpnNodeId === locator.previousVpnNodeId &&
    sameNullableDate(sandbox.cleanupVpnRegistrationStartedAt, locator.vpnRegistrationStartedAt) &&
    sandbox.cleanupAllocationCounted === true &&
    sandbox.cleanupCreatedAt !== null
  );
}

function assertCandidateOrEmptyCleanupFence(
  sandbox: LockedAgentSandboxAuthority,
  attempt: AgentSandboxReplacementAttempt,
  locator: ValidatedLocator,
  reference: ValidatedReference,
): "candidate" | "empty" {
  if (!hasAnyReplacementCleanupAuthority(sandbox)) return "empty";
  if (!candidateCleanupFenceMatches(sandbox, attempt, locator)) {
    throw conflict("Canonical replacement candidate cleanup fence does not match", reference);
  }
  return "candidate";
}

function oldPrimaryCleanupFenceMatches(
  sandbox: LockedAgentSandboxAuthority,
  attempt: AgentSandboxReplacementAttempt,
): boolean {
  return (
    attempt.previous_placement_absent === false &&
    attempt.lifecycle_committed_at !== null &&
    sandbox.sandboxId === attempt.locator_sandbox_id &&
    sandbox.nodeId === attempt.locator_node_id &&
    sandbox.containerName === attempt.locator_container_name &&
    sandbox.cleanupSandboxId === attempt.previous_sandbox_id &&
    sandbox.cleanupNodeId === attempt.previous_node_id &&
    sandbox.cleanupNodeRecordId === attempt.previous_node_record_id &&
    sandbox.cleanupNodeIncarnation === attempt.previous_node_incarnation &&
    sandbox.cleanupNodeHistoryId === attempt.previous_node_history_id &&
    sandbox.cleanupNodeHostname === attempt.previous_node_hostname &&
    sandbox.cleanupNodeSshPort === attempt.previous_node_ssh_port &&
    sandbox.cleanupNodeSshUser === attempt.previous_node_ssh_user &&
    sandbox.cleanupNodeHostKeyFingerprint === attempt.previous_node_host_key_fingerprint &&
    sandbox.cleanupSecretCleanupVersion === null &&
    sandbox.cleanupContainerName === attempt.previous_container_name &&
    sandbox.cleanupAttemptId === attempt.id &&
    typeof sandbox.cleanupContainerId === "string" &&
    CANONICAL_FULL_CONTAINER_ID.test(sandbox.cleanupContainerId) &&
    sandbox.cleanupContainerId === attempt.previous_container_id &&
    sandbox.cleanupVpnNodeId === attempt.locator_previous_vpn_node_id &&
    sandbox.cleanupVpnNodeName === null &&
    sandbox.cleanupPreservedVpnNodeId === null &&
    sandbox.cleanupVpnRegistrationStartedAt === null &&
    sandbox.cleanupAllocationCounted === true &&
    sandbox.cleanupCreatedAt?.getTime() === attempt.lifecycle_committed_at.getTime()
  );
}

/** Classify the exact canonical pre-state while its row lock is held. */
function classifyPreviousPlacementAbsent(
  sandbox: LockedAgentSandboxAuthority,
  expected: ValidatedStart,
  allowAdvancedLifecycleRevision = false,
): boolean {
  assertAgentSandboxAuthorityMatches(sandbox, expected, allowAdvancedLifecycleRevision);
  if (sandbox.deletionAttemptId !== null) {
    throw conflict("Agent sandbox has conflicting deletion authority", expected);
  }
  const placementParts = [sandbox.sandboxId, sandbox.nodeId, sandbox.containerName];
  const presentPlacementParts = placementParts.filter((value) => value !== null).length;
  if (presentPlacementParts !== 0 && presentPlacementParts !== placementParts.length) {
    throw conflict("Canonical sandbox placement is partial", expected);
  }
  if (presentPlacementParts === 0) {
    const freshProvision =
      sandbox.activationPurpose === "provision" &&
      expected.restoreAuthority === null &&
      ["pending", "provisioning"].includes(sandbox.status);
    const wake = sandbox.activationPurpose === "wake" && sandbox.status === "sleeping";
    const restore =
      sandbox.activationPurpose === "restore" &&
      expected.restoreAuthority !== null &&
      sandbox.activationGeneration === expected.restoreAuthority.restoreAttemptId &&
      sandbox.status === "sleeping";
    if (
      (hasAnyReplacementCleanupAuthority(sandbox) && !allowAdvancedLifecycleRevision) ||
      expected.operationKind !== "provision" ||
      (!freshProvision && !wake && !restore) ||
      sandbox.deletionAllocationCounted === true
    ) {
      throw conflict(
        "Only a fresh provision or sleeping wake may own an absent placement",
        expected,
      );
    }
    return true;
  }
  if (!canonicalSandboxPlacementOwnsCapacity(sandbox)) {
    throw conflict("Canonical previous placement does not own counted capacity", expected);
  }
  return false;
}

function assertCanonicalPatchMatches(
  sandbox: LockedAgentSandboxAuthority,
  patch: ValidatedCanonicalPatch,
  expected: ValidatedReference,
): void {
  if (
    sandbox.status !== patch.status ||
    sandbox.bridgeUrl !== patch.bridgeUrl ||
    sandbox.healthUrl !== patch.healthUrl ||
    sandbox.lastHeartbeatAt?.getTime() !== patch.lastHeartbeatAt.getTime() ||
    sandbox.errorMessage !== patch.errorMessage ||
    sandbox.bridgePort !== patch.bridgePort ||
    sandbox.webUiPort !== patch.webUiPort ||
    sandbox.headscaleIp !== patch.headscaleIp ||
    sandbox.dockerImage !== patch.dockerImage ||
    sandbox.imageDigest !== patch.imageDigest ||
    sandbox.previousDockerImage !== patch.previousDockerImage ||
    sandbox.previousImageDigest !== patch.previousImageDigest
  ) {
    throw conflict("Canonical sandbox provider metadata does not match", expected);
  }
}

function assertCanonicalPatchMatchesPreState(
  sandbox: LockedAgentSandboxAuthority,
  expected: ValidatedStart,
  previousPlacement: ValidatedPreviousPlacement | null,
  patch: ValidatedCanonicalPatch,
): void {
  if (previousPlacement === null) {
    if (patch.previousDockerImage !== null || patch.previousImageDigest !== null) {
      throw conflict("First provision cannot invent a previous image", expected);
    }
    return;
  }
  if (expected.operationKind === "upgrade") {
    if (
      patch.previousDockerImage !== sandbox.dockerImage ||
      patch.previousImageDigest !== sandbox.imageDigest
    ) {
      throw conflict("Upgrade rollback image does not match canonical pre-state", expected);
    }
    return;
  }
  if (expected.operationKind === "downgrade") {
    if (
      !sandbox.previousDockerImage ||
      !sandbox.previousImageDigest ||
      patch.dockerImage !== sandbox.previousDockerImage ||
      patch.imageDigest !== sandbox.previousImageDigest ||
      patch.previousDockerImage !== null ||
      patch.previousImageDigest !== null
    ) {
      throw conflict("Downgrade image does not match canonical rollback authority", expected);
    }
    return;
  }
  if (
    patch.previousDockerImage !== sandbox.previousDockerImage ||
    patch.previousImageDigest !== sandbox.previousImageDigest
  ) {
    throw conflict("Provision image history does not match canonical pre-state", expected);
  }
}

function canonicalSandboxPlacementOwnsCapacity(sandbox: LockedAgentSandboxAuthority): boolean {
  return (
    sandbox.deletionAllocationCounted === true ||
    (sandbox.deletionAllocationCounted === null &&
      !["stopped", "error", "sleeping", "deletion_failed"].includes(sandbox.status))
  );
}

function assertAgentSandboxLifecycleAdoptionPreState(
  sandbox: LockedAgentSandboxAuthority,
  expected: ValidatedStart,
  previousPlacement: ValidatedPreviousPlacement | null,
  cleanupFenceMode: "candidate" | "empty",
): void {
  const previousPlacementAbsent = classifyPreviousPlacementAbsent(
    sandbox,
    expected,
    cleanupFenceMode === "candidate",
  );
  if (previousPlacementAbsent !== (previousPlacement === null)) {
    throw conflict("Canonical sandbox lifecycle adoption pre-state does not match", expected);
  }
  if ((cleanupFenceMode === "candidate") !== hasAnyReplacementCleanupAuthority(sandbox)) {
    throw conflict("Canonical sandbox candidate cleanup mode changed", expected);
  }
  if (
    previousPlacement !== null &&
    (sandbox.sandboxId !== previousPlacement.sandboxId ||
      sandbox.nodeId !== previousPlacement.nodeId ||
      sandbox.containerName !== previousPlacement.containerName)
  ) {
    throw conflict("Canonical sandbox lifecycle adoption pre-state does not match", expected);
  }
}

function assertAgentSandboxLifecycleAdoptionPostState(
  sandbox: LockedAgentSandboxAuthority,
  expected: ValidatedStart,
  locator: ValidatedLocator,
  previousPlacement: ValidatedPreviousPlacement | null,
  canonicalPatch: ValidatedCanonicalPatch,
  committedAt: Date,
  previousAuthority?: LockedPreviousPlacementAuthority | null,
  previousCleanupState: "pending" | "released" | null = null,
): void {
  const lifecycleRevision = BigInt(sandbox.lifecycleRevision);
  if (
    sandbox.id !== expected.agentId ||
    sandbox.organizationId !== expected.organizationId ||
    lifecycleRevision < expected.lifecycleRevision + 1n ||
    sandbox.activationGeneration !== expected.activationGeneration ||
    sandbox.lifecycleJobId !== expected.lifecycleJobId ||
    sandbox.lifecycleExecutionGeneration !== expected.lifecycleExecutionGeneration ||
    sandbox.deletionAttemptId !== null ||
    !canonicalSandboxPlacementOwnsCapacity(sandbox) ||
    sandbox.sandboxId !== locator.sandboxId ||
    sandbox.nodeId !== locator.nodeId ||
    sandbox.containerName !== locator.containerName
  ) {
    throw conflict("Canonical sandbox lifecycle adoption does not match", expected);
  }
  assertCanonicalPatchMatches(sandbox, canonicalPatch, expected);
  if (previousPlacement === null) {
    if (
      (previousAuthority !== undefined && previousAuthority !== null) ||
      previousCleanupState !== null ||
      hasAnyReplacementCleanupAuthority(sandbox)
    ) {
      throw conflict("First provision adoption unexpectedly retained cleanup authority", expected);
    }
    return;
  }
  if (previousCleanupState === "released") {
    if (hasAnyReplacementCleanupAuthority(sandbox)) {
      throw conflict("Released previous cleanup unexpectedly retained its sandbox fence", expected);
    }
    return;
  }
  if (
    previousCleanupState !== "pending" ||
    sandbox.cleanupSandboxId !== previousPlacement.sandboxId ||
    sandbox.cleanupNodeId !== previousPlacement.nodeId ||
    !sandbox.cleanupNodeRecordId ||
    !sandbox.cleanupNodeIncarnation ||
    !sandbox.cleanupNodeHistoryId ||
    !sandbox.cleanupNodeHostname ||
    !sandbox.cleanupNodeSshPort ||
    !sandbox.cleanupNodeSshUser ||
    !sandbox.cleanupNodeHostKeyFingerprint ||
    (previousAuthority !== undefined &&
      (previousAuthority === null ||
        sandbox.cleanupNodeRecordId !== previousAuthority.nodeRecordId ||
        sandbox.cleanupNodeIncarnation !== previousAuthority.nodeIncarnation ||
        sandbox.cleanupNodeHistoryId !== previousAuthority.nodeHistoryId ||
        sandbox.cleanupNodeHostname !== previousAuthority.nodeHostname ||
        sandbox.cleanupNodeSshPort !== previousAuthority.nodeSshPort ||
        sandbox.cleanupNodeSshUser !== previousAuthority.nodeSshUser ||
        sandbox.cleanupNodeHostKeyFingerprint !== previousAuthority.nodeHostKeyFingerprint)) ||
    sandbox.cleanupSecretCleanupVersion !== null ||
    sandbox.cleanupContainerName !== previousPlacement.containerName ||
    sandbox.cleanupAttemptId !== expected.attemptId ||
    sandbox.cleanupContainerId !== previousAuthority?.containerId ||
    sandbox.cleanupVpnNodeId !== locator.previousVpnNodeId ||
    sandbox.cleanupVpnNodeName !== null ||
    sandbox.cleanupPreservedVpnNodeId !== null ||
    sandbox.cleanupVpnRegistrationStartedAt !== null ||
    sandbox.cleanupAllocationCounted !== previousPlacement.allocationCounted ||
    sandbox.cleanupCreatedAt?.getTime() !== committedAt.getTime()
  ) {
    throw conflict("Canonical sandbox lifecycle adoption does not match", expected);
  }
}

async function lockAndValidateAgentSandboxAuthority(
  tx: DbTransaction,
  expected: ValidatedStart,
): Promise<LockedAgentSandboxAuthority> {
  const sandbox = await lockAgentSandboxAuthority(tx, expected);
  assertAgentSandboxAuthorityMatches(sandbox, expected);
  return sandbox;
}

async function assertRestoreLeaseNotExpired(
  tx: DbTransaction,
  expiresAt: Date,
  reference: ValidatedReference,
): Promise<void> {
  const databaseNow = await readPostLockDatabaseNow(tx);
  if (expiresAt <= databaseNow) {
    throw conflict("Restore lease is expired or released", reference);
  }
}

interface LockedPreviousPlacementAuthority extends ValidatedPreviousPlacement {
  containerId: string;
  nodeRecordId: string;
  nodeIncarnation: string;
  nodeHistoryId: string;
  nodeHostname: string;
  nodeSshPort: number;
  nodeSshUser: string;
  nodeHostKeyFingerprint: string;
}

async function lockPreviousPlacementAuthorityAtStart(
  tx: DbTransaction,
  sandbox: LockedAgentSandboxAuthority,
  expected: ValidatedStart,
  previousPlacementAbsent: boolean,
): Promise<LockedPreviousPlacementAuthority | null> {
  if (previousPlacementAbsent) return null;
  if (!sandbox.sandboxId || !sandbox.nodeId || !sandbox.containerName) {
    throw conflict("Canonical previous placement is incomplete", expected);
  }
  if (sandbox.activationPreviousGeneration === null) {
    throw conflict("Previous activation generation is missing", expected);
  }
  const [publication] = await tx
    .select()
    .from(agentActivationPublications)
    .where(
      and(
        eq(agentActivationPublications.organization_id, expected.organizationId),
        eq(agentActivationPublications.agent_id, expected.agentId),
        eq(agentActivationPublications.activation_generation, sandbox.activationPreviousGeneration),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !publication ||
    publication.node_id !== sandbox.nodeId ||
    !CANONICAL_FULL_CONTAINER_ID.test(publication.container_id)
  ) {
    throw conflict("Previous activation publication does not match canonical placement", expected);
  }
  const [node] = await tx
    .select()
    .from(dockerNodes)
    .where(
      and(
        eq(dockerNodes.id, publication.docker_node_record_id),
        eq(dockerNodes.node_id, publication.node_id),
        eq(dockerNodes.node_incarnation, publication.node_incarnation),
        eq(dockerNodes.current_node_history_id, publication.node_history_id),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !node ||
    !node.hostname.trim() ||
    !node.ssh_user.trim() ||
    !node.host_key_fingerprint?.trim() ||
    node.allocated_count < 1
  ) {
    throw conflict(
      "Previous published Docker-node occurrence is not current and counted",
      expected,
    );
  }
  return {
    sandboxId: sandbox.sandboxId,
    nodeId: sandbox.nodeId,
    containerName: sandbox.containerName,
    containerId: publication.container_id,
    allocationCounted: true,
    nodeRecordId: node.id,
    nodeIncarnation: publication.node_incarnation,
    nodeHistoryId: publication.node_history_id,
    nodeHostname: node.hostname,
    nodeSshPort: node.ssh_port,
    nodeSshUser: node.ssh_user,
    nodeHostKeyFingerprint: node.host_key_fingerprint,
  };
}

function previousPlacementAuthorityFromAttempt(
  attempt: AgentSandboxReplacementAttempt,
  previousPlacement: ValidatedPreviousPlacement | null,
  reference: ValidatedReference,
): LockedPreviousPlacementAuthority | null {
  const previousFields = [
    attempt.previous_sandbox_id,
    attempt.previous_node_id,
    attempt.previous_container_name,
    attempt.previous_container_id,
    attempt.previous_allocation_counted,
    attempt.previous_node_record_id,
    attempt.previous_node_incarnation,
    attempt.previous_node_history_id,
    attempt.previous_node_hostname,
    attempt.previous_node_ssh_port,
    attempt.previous_node_ssh_user,
    attempt.previous_node_host_key_fingerprint,
  ];
  if (previousPlacement === null) {
    if (previousFields.some((value) => value !== null)) {
      throw conflict("Absent previous placement contains forged authority", reference);
    }
    return null;
  }
  if (
    attempt.previous_sandbox_id !== previousPlacement.sandboxId ||
    attempt.previous_node_id !== previousPlacement.nodeId ||
    attempt.previous_container_name !== previousPlacement.containerName ||
    attempt.previous_allocation_counted !== previousPlacement.allocationCounted ||
    !attempt.previous_container_id ||
    !attempt.previous_node_record_id ||
    !attempt.previous_node_incarnation ||
    !attempt.previous_node_history_id ||
    !attempt.previous_node_hostname ||
    !attempt.previous_node_ssh_port ||
    !attempt.previous_node_ssh_user ||
    !attempt.previous_node_host_key_fingerprint
  ) {
    throw conflict("Durable previous-placement authority does not match", reference);
  }
  return {
    ...previousPlacement,
    containerId: attempt.previous_container_id,
    nodeRecordId: attempt.previous_node_record_id,
    nodeIncarnation: attempt.previous_node_incarnation,
    nodeHistoryId: attempt.previous_node_history_id,
    nodeHostname: attempt.previous_node_hostname,
    nodeSshPort: attempt.previous_node_ssh_port,
    nodeSshUser: attempt.previous_node_ssh_user,
    nodeHostKeyFingerprint: attempt.previous_node_host_key_fingerprint,
  };
}

async function lockAndValidateReplacementAndPreviousNodeAuthorities(
  tx: DbTransaction,
  locator: ValidatedLocator,
  previousPlacement: ValidatedPreviousPlacement | null,
  attempt: AgentSandboxReplacementAttempt,
  reference: ValidatedReference,
): Promise<LockedPreviousPlacementAuthority | null> {
  const previousAuthority = previousPlacementAuthorityFromAttempt(
    attempt,
    previousPlacement,
    reference,
  );
  if (
    previousAuthority !== null &&
    (previousAuthority.nodeId === locator.nodeId ||
      previousAuthority.nodeRecordId === locator.nodeRecordId)
  ) {
    throw conflict("Replacement target must differ from the previous Docker node", reference);
  }
  const nodes = await tx
    .select()
    .from(dockerNodes)
    .where(
      previousAuthority === null
        ? eq(dockerNodes.id, locator.nodeRecordId)
        : or(
            eq(dockerNodes.id, locator.nodeRecordId),
            eq(dockerNodes.id, previousAuthority.nodeRecordId),
          ),
    )
    // Lock both occurrences in immutable-record order so opposing moves cannot
    // deadlock while freezing the previous placement's cleanup authority.
    .orderBy(dockerNodes.id)
    .for("update")
    .limit(previousAuthority === null ? 1 : 2);
  const replacementNode = nodes.find(
    (node) =>
      node.id === locator.nodeRecordId &&
      node.node_id === locator.nodeId &&
      node.node_incarnation === locator.nodeIncarnation &&
      node.current_node_history_id === locator.nodeHistoryId &&
      node.hostname === locator.nodeHostname &&
      node.ssh_port === locator.nodeSshPort &&
      node.ssh_user === locator.nodeSshUser &&
      node.host_key_fingerprint === locator.nodeHostKeyFingerprint &&
      node.allocated_count > 0,
  );
  if (!replacementNode) {
    throw conflict("Replacement Docker-node authority does not match", reference);
  }
  if (previousAuthority === null) return null;
  const previousNode = nodes.find(
    (node) =>
      node.id === previousAuthority.nodeRecordId &&
      node.node_id === previousAuthority.nodeId &&
      node.node_incarnation === previousAuthority.nodeIncarnation &&
      node.current_node_history_id === previousAuthority.nodeHistoryId &&
      node.hostname === previousAuthority.nodeHostname &&
      node.ssh_port === previousAuthority.nodeSshPort &&
      node.ssh_user === previousAuthority.nodeSshUser &&
      node.host_key_fingerprint === previousAuthority.nodeHostKeyFingerprint,
  );
  if (!previousNode || previousNode.allocated_count < 1) {
    throw conflict("Previous published Docker-node occurrence is no longer current", reference);
  }
  return previousAuthority;
}

async function lockRestoreStartAuthority(
  tx: DbTransaction,
  validated: ValidatedStart,
): Promise<AgentBackupRestoreLease | null> {
  const restore = validated.restoreAuthority;
  if (!restore) return null;
  // Global ordering is backup -> operation -> lease -> sandbox. Admission
  // calls this before rotating the sandbox, then start safely re-enters the
  // same locks in its transaction.
  const [backup] = await tx
    .select({ id: agentSandboxBackups.id })
    .from(agentSandboxBackups)
    .where(
      and(
        eq(agentSandboxBackups.id, restore.backupId),
        eq(agentSandboxBackups.catalog_organization_id, validated.organizationId),
        eq(agentSandboxBackups.catalog_agent_id, validated.agentId),
        eq(agentSandboxBackups.backup_operation_id, restore.operationId),
        eq(agentSandboxBackups.lifecycle_generation, restore.sourceActivationGeneration),
        eq(agentSandboxBackups.lifecycle_revision, restore.sourceLifecycleRevision),
        eq(agentSandboxBackups.manifest_digest, restore.expectedManifestSha256),
        eq(agentSandboxBackups.catalog_revision, restore.catalogEpoch),
      ),
    )
    .for("update")
    .limit(1);
  if (!backup) {
    throw conflict("Restore backup authority does not match", validated);
  }

  const [restoreOperation] = await tx
    .select()
    .from(agentBackupRestoreOperations)
    .where(
      and(
        eq(agentBackupRestoreOperations.organization_id, validated.organizationId),
        eq(agentBackupRestoreOperations.restore_attempt_id, restore.restoreAttemptId),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !restoreOperation ||
    restoreOperation.agent_id !== validated.agentId ||
    restoreOperation.backup_id !== restore.backupId ||
    restoreOperation.lease_id !== restore.leaseId ||
    restoreOperation.lease_generation !== restore.fencingToken ||
    restoreOperation.lease_owner_id !== restore.ownerId ||
    restoreOperation.catalog_epoch !== restore.catalogEpoch ||
    restoreOperation.copy_role !== restore.copyRole ||
    restoreOperation.expected_operation_id !== restore.operationId ||
    restoreOperation.expected_activation_generation !== restore.sourceActivationGeneration ||
    restoreOperation.expected_lifecycle_revision !== restore.sourceLifecycleRevision ||
    restoreOperation.expected_manifest_sha256 !== restore.expectedManifestSha256 ||
    restoreOperation.expected_node_record_id === null ||
    restoreOperation.expected_node_id === null ||
    restoreOperation.expected_node_incarnation === null ||
    restoreOperation.expected_node_history_id === null ||
    restoreOperation.capacity_state !== "reserved" ||
    restoreOperation.capacity_reserved_at === null
  ) {
    throw conflict("Restore capacity operation authority does not match", validated);
  }

  const [lease] = await tx
    .select()
    .from(agentBackupRestoreLeases)
    .where(
      and(
        eq(agentBackupRestoreLeases.id, restore.leaseId),
        eq(agentBackupRestoreLeases.organization_id, validated.organizationId),
        eq(agentBackupRestoreLeases.agent_id, validated.agentId),
        eq(agentBackupRestoreLeases.backup_id, restore.backupId),
        eq(agentBackupRestoreLeases.restore_attempt_id, restore.restoreAttemptId),
        eq(agentBackupRestoreLeases.owner_id, restore.ownerId),
        eq(agentBackupRestoreLeases.generation, restore.fencingToken),
        eq(agentBackupRestoreLeases.catalog_epoch, restore.catalogEpoch),
        eq(agentBackupRestoreLeases.copy_role, restore.copyRole),
        eq(agentBackupRestoreLeases.operation_id, restore.operationId),
        eq(agentBackupRestoreLeases.activation_generation, restore.sourceActivationGeneration),
        eq(agentBackupRestoreLeases.lifecycle_revision, restore.sourceLifecycleRevision),
        eq(agentBackupRestoreLeases.expected_manifest_sha256, restore.expectedManifestSha256),
      ),
    )
    .for("update")
    .limit(1);
  if (!lease || lease.expires_at.getTime() !== restore.expiresAt.getTime()) {
    throw conflict("Restore lease replay authority does not match", validated);
  }
  return lease;
}

/**
 * Insert the pre-effect one-shot marker. Any existing ID is rejected even when
 * its bytes match: replaying start could launch provider effects a second time.
 * The caller owns the transaction so its lifecycle admission CAS and this row
 * either commit or roll back together. This function owns the complete lock
 * order: organization (KEY SHARE), restore authority when present (UPDATE),
 * sandbox (UPDATE), then attempt insert. A caller must not pre-lock the sandbox
 * before entering this function unless it has already acquired every preceding
 * lock in this exact order (as the atomic admission helper does below).
 */
export async function startAgentSandboxReplacementAttemptInTransaction(
  tx: DbTransaction,
  input: StartAgentSandboxReplacementAttemptInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  const validated = validateStart(input);
  try {
    // Take the FK parent first. Account deletion takes the same organization
    // row before cascading through sandboxes and attempts, so every path now
    // agrees on organization -> sandbox instead of forming an AB-BA cycle.
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, validated.organizationId))
      .for("key share")
      .limit(1);
    if (!organization) {
      throw conflict("Replacement attempt organization authority is missing", validated);
    }

    const restore = validated.restoreAuthority;
    const restoreLease = await lockRestoreStartAuthority(tx, validated);
    let restoreLeaseExpiresAt: Date | null = null;
    if (restoreLease) {
      if (restoreLease.released_at !== null) {
        throw conflict("Restore lease is expired or released", validated);
      }
      restoreLeaseExpiresAt = new Date(restoreLease.expires_at.getTime());
      await assertRestoreLeaseNotExpired(tx, restoreLeaseExpiresAt, validated);
    }
    const sandbox = await lockAndValidateAgentSandboxAuthority(tx, validated);
    const previousPlacementAbsent = classifyPreviousPlacementAbsent(sandbox, validated);
    const previousPlacementAuthority = await lockPreviousPlacementAuthorityAtStart(
      tx,
      sandbox,
      validated,
      previousPlacementAbsent,
    );
    if (restoreLeaseExpiresAt) {
      // The sandbox lock may wait behind a lifecycle writer. Re-read the
      // primary clock only after that wait so an expired lease can never fund
      // an attempt merely because it was live before sandbox serialization.
      await assertRestoreLeaseNotExpired(tx, restoreLeaseExpiresAt, validated);
    }

    const [created] = await tx
      .insert(agentSandboxReplacementAttempts)
      .values({
        id: validated.attemptId,
        organization_id: validated.organizationId,
        agent_id: validated.agentId,
        operation_kind: validated.operationKind,
        lifecycle_revision: validated.lifecycleRevision,
        activation_generation: validated.activationGeneration,
        lifecycle_job_id: validated.lifecycleJobId,
        lifecycle_execution_generation: validated.lifecycleExecutionGeneration,
        previous_placement_absent: previousPlacementAbsent,
        previous_sandbox_id: previousPlacementAuthority?.sandboxId ?? null,
        previous_node_id: previousPlacementAuthority?.nodeId ?? null,
        previous_container_name: previousPlacementAuthority?.containerName ?? null,
        previous_container_id: previousPlacementAuthority?.containerId ?? null,
        previous_allocation_counted: previousPlacementAuthority?.allocationCounted ?? null,
        previous_node_record_id: previousPlacementAuthority?.nodeRecordId ?? null,
        previous_node_incarnation: previousPlacementAuthority?.nodeIncarnation ?? null,
        previous_node_history_id: previousPlacementAuthority?.nodeHistoryId ?? null,
        previous_node_hostname: previousPlacementAuthority?.nodeHostname ?? null,
        previous_node_ssh_port: previousPlacementAuthority?.nodeSshPort ?? null,
        previous_node_ssh_user: previousPlacementAuthority?.nodeSshUser ?? null,
        previous_node_host_key_fingerprint:
          previousPlacementAuthority?.nodeHostKeyFingerprint ?? null,
        restore_lease_id: restore?.leaseId ?? null,
        restore_backup_id: restore?.backupId ?? null,
        restore_attempt_id: restore?.restoreAttemptId ?? null,
        restore_lease_owner_id: restore?.ownerId ?? null,
        restore_lease_generation: restore?.fencingToken ?? null,
        restore_catalog_epoch: restore?.catalogEpoch ?? null,
        restore_copy_role: restore?.copyRole ?? null,
        restore_operation_id: restore?.operationId ?? null,
        restore_source_activation_generation: restore?.sourceActivationGeneration ?? null,
        restore_source_lifecycle_revision: restore?.sourceLifecycleRevision ?? null,
        restore_manifest_sha256: restore?.expectedManifestSha256 ?? null,
        restore_lease_expires_at: restoreLeaseExpiresAt,
      })
      .returning();
    if (!created) {
      throw conflict("Replacement attempt insert returned no row", validated);
    }
    if (restoreLeaseExpiresAt) {
      // INSERT can itself wait on a primary-key or partial-unique-index rival.
      // Revalidate after RETURNING so no blocking operation can admit provider
      // work under authority that expired while this transaction was waiting.
      await assertRestoreLeaseNotExpired(tx, restoreLeaseExpiresAt, validated);
    }
    return frozenResult(created, false);
  } catch (error) {
    if (error instanceof ElizaError) throw error;
    // error-policy:J1 repository boundary translates primary-key, agent-wide
    // active-effect, and generation-fence races into one authority conflict.
    if (isUniqueConstraintError(error)) {
      throw conflict(
        "Replacement attempt ID, agent-wide effect, or activation generation is already owned",
        validated,
      );
    }
    throw error;
  }
}

function assertReplacementAdmissionPreState(
  sandbox: LockedAgentSandboxAuthority,
  admission: ValidatedAdmission,
): void {
  if (
    sandbox.id !== admission.agentId ||
    sandbox.organizationId !== admission.organizationId ||
    sandbox.lifecycleRevision !== admission.expectedLifecycleRevision.toString() ||
    sandbox.lifecycleJobId !== admission.lifecycleJobId ||
    sandbox.lifecycleExecutionGeneration !== admission.lifecycleExecutionGeneration ||
    sandbox.deletedAt !== null ||
    sandbox.deletionAttemptId !== null ||
    sandbox.deletionAllocationCounted !== null ||
    ["deletion_pending", "deletion_failed"].includes(sandbox.status) ||
    hasAnyReplacementCleanupAuthority(sandbox)
  ) {
    throw conflict("Replacement admission lifecycle authority does not match", admission);
  }
  if (sandbox.activationGeneration === admission.targetActivationGeneration) {
    throw conflict("Replacement admission target generation was already used", admission);
  }
  if (
    sandbox.activationGeneration !== null &&
    (sandbox.activationPhase !== "active" || sandbox.activationReceiptHash === null)
  ) {
    throw conflict("Replacement admission cannot overwrite an unfinished activation", admission);
  }
  const placementParts = [sandbox.sandboxId, sandbox.nodeId, sandbox.containerName];
  const presentPlacementParts = placementParts.filter((value) => value !== null).length;
  if (presentPlacementParts !== 0 && presentPlacementParts !== placementParts.length) {
    throw conflict("Replacement admission found a partial canonical placement", admission);
  }
  if (admission.restoreAuthority !== null) {
    if (presentPlacementParts === 0) {
      if (admission.operationKind !== "provision" || sandbox.status !== "sleeping") {
        throw conflict("Restore admission requires an unplaced sleeping sandbox", admission);
      }
      return;
    }
    if (!canonicalSandboxPlacementOwnsCapacity(sandbox)) {
      throw conflict("Restore admission previous placement does not own capacity", admission);
    }
    return;
  }
  if (admission.activationPurpose === "wake") {
    if (
      admission.operationKind !== "provision" ||
      presentPlacementParts !== 0 ||
      sandbox.status !== "sleeping" ||
      sandbox.deletionAllocationCounted === true
    ) {
      throw conflict("Wake admission requires an unplaced sleeping sandbox", admission);
    }
    return;
  }
  if (presentPlacementParts === 0) {
    if (
      admission.operationKind !== "provision" ||
      !["pending", "provisioning"].includes(sandbox.status) ||
      sandbox.deletionAllocationCounted === true
    ) {
      throw conflict("Fresh provision admission found an incompatible sandbox state", admission);
    }
    return;
  }
  if (!canonicalSandboxPlacementOwnsCapacity(sandbox)) {
    throw conflict("Replacement admission previous placement does not own capacity", admission);
  }
}

function restoreAuthorityInput(
  authority: ValidatedRestoreAuthority | null,
): AgentSandboxReplacementRestoreAuthority | null {
  if (!authority) return null;
  return Object.freeze({
    leaseId: authority.leaseId,
    backupId: authority.backupId,
    restoreAttemptId: authority.restoreAttemptId,
    ownerId: authority.ownerId,
    fencingToken: authority.fencingToken,
    catalogEpoch: authority.catalogEpoch.toString(),
    copyRole: authority.copyRole,
    operationId: authority.operationId,
    sourceActivationGeneration: authority.sourceActivationGeneration,
    sourceLifecycleRevision: authority.sourceLifecycleRevision.toString(),
    expectedManifestSha256: authority.expectedManifestSha256,
    expiresAt: new Date(authority.expiresAt.getTime()),
  });
}

/**
 * Rotate a tenant activation and insert its one-shot provider marker in one
 * caller-owned transaction. No provider effect may run before this returns.
 */
export async function admitAndStartAgentSandboxReplacementInTransaction(
  tx: DbTransaction,
  input: AdmitAndStartAgentSandboxReplacementInput,
): Promise<AdmitAndStartAgentSandboxReplacementResult> {
  const admission = validateAdmission(input);
  const startInput: StartAgentSandboxReplacementAttemptInput = Object.freeze({
    attemptId: admission.attemptId,
    organizationId: admission.organizationId,
    agentId: admission.agentId,
    operationKind: admission.operationKind,
    lifecycleRevision: (admission.expectedLifecycleRevision + 1n).toString(),
    activationGeneration: admission.targetActivationGeneration,
    lifecycleJobId: admission.lifecycleJobId,
    lifecycleExecutionGeneration: admission.lifecycleExecutionGeneration,
    restoreAuthority: restoreAuthorityInput(admission.restoreAuthority),
  });
  const validatedStart = validateStart(startInput);
  const effectiveActivationPurpose = admission.restoreAuthority
    ? ("restore" as const)
    : admission.activationPurpose;
  // Admission rotates the sandbox before delegating to start, so it must first
  // take the same FK-parent lock as start. Account deletion also begins here;
  // organization -> restore authority -> sandbox prevents the AB-BA cycle.
  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, admission.organizationId))
    .for("key share")
    .limit(1);
  if (!organization) {
    throw conflict("Replacement attempt organization authority is missing", admission);
  }

  // Preserve the global restore lock order before taking the mutable sandbox.
  // start safely re-enters these transaction-owned locks without waiting.
  await lockRestoreStartAuthority(tx, validatedStart);
  const sandbox = await lockAgentSandboxAuthority(tx, admission);
  assertReplacementAdmissionPreState(sandbox, admission);
  const databaseNow = await readPostLockDatabaseNow(tx);
  const [rotated] = await tx
    .update(agentSandboxes)
    .set({
      activation_previous_generation: sandbox.activationGeneration,
      activation_generation: admission.targetActivationGeneration,
      activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
      activation_purpose: effectiveActivationPurpose,
      activation_phase: "container_pending",
      activation_backup_id: admission.restoreAuthority?.backupId ?? null,
      activation_backup_hash: admission.restoreAuthority?.expectedManifestSha256 ?? null,
      activation_receipt: null,
      activation_receipt_hash: null,
      activation_container_id: null,
      activation_node_id: null,
      activation_image_digest: null,
      activation_token_hash: admission.activationTokenSha256,
      activation_token_ciphertext: admission.activationTokenCiphertext,
      activation_boot_id: null,
      activation_authority_published_at: null,
      activation_funding_revision: null,
      activation_dispatched_at: null,
      activation_completed_at: null,
      activation_consent_lifecycle_revision: null,
      activation_consent_head_backup_id: null,
      activation_consent_head_backup_hash: null,
      updated_at: databaseNow,
    })
    .where(
      and(
        eq(agentSandboxes.id, admission.agentId),
        eq(agentSandboxes.organization_id, admission.organizationId),
        sql`${agentSandboxes.lifecycle_revision}
          = ${admission.expectedLifecycleRevision.toString()}::bigint`,
        sql`${agentSandboxes.activation_generation}
          IS NOT DISTINCT FROM ${sandbox.activationGeneration}`,
        sql`${agentSandboxes.lifecycle_job_id}
          IS NOT DISTINCT FROM ${admission.lifecycleJobId}`,
        sql`${agentSandboxes.lifecycle_execution_generation}
          IS NOT DISTINCT FROM ${admission.lifecycleExecutionGeneration}`,
        sql`${agentSandboxes.deleted_at} IS NULL`,
        sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
        sql`${agentSandboxes.replacement_cleanup_sandbox_id} IS NULL`,
      ),
    )
    .returning({
      lifecycleRevision: agentSandboxes.lifecycle_revision,
      activationGeneration: agentSandboxes.activation_generation,
      activationPreviousGeneration: agentSandboxes.activation_previous_generation,
      activationLifecycleRevision: agentSandboxes.activation_lifecycle_revision,
      activationPurpose: agentSandboxes.activation_purpose,
      activationPhase: agentSandboxes.activation_phase,
      activationTokenHash: agentSandboxes.activation_token_hash,
      activationTokenCiphertext: agentSandboxes.activation_token_ciphertext,
    });
  if (
    !rotated ||
    BigInt(rotated.lifecycleRevision) !== admission.expectedLifecycleRevision + 1n ||
    rotated.activationGeneration !== admission.targetActivationGeneration ||
    rotated.activationPreviousGeneration !== sandbox.activationGeneration ||
    rotated.activationLifecycleRevision !== admission.expectedLifecycleRevision + 1n ||
    rotated.activationPurpose !== effectiveActivationPurpose ||
    rotated.activationPhase !== "container_pending" ||
    rotated.activationTokenHash !== admission.activationTokenSha256 ||
    rotated.activationTokenCiphertext !== admission.activationTokenCiphertext
  ) {
    throw conflict("Replacement admission lost its activation rotation CAS", admission);
  }

  const started = await startAgentSandboxReplacementAttemptInTransaction(tx, startInput);
  const minimalPreviousPlacement: ValidatedPreviousPlacement | null =
    started.attempt.previous_placement_absent === false
      ? {
          sandboxId: started.attempt.previous_sandbox_id!,
          nodeId: started.attempt.previous_node_id!,
          containerName: started.attempt.previous_container_name!,
          allocationCounted: true,
        }
      : null;
  const previousPlacement = previousPlacementAuthorityFromAttempt(
    started.attempt,
    minimalPreviousPlacement,
    admission,
  );
  return Object.freeze({
    startInput,
    previousPlacement: previousPlacement ? Object.freeze(previousPlacement) : null,
    attempt: started.attempt,
  });
}

async function lockReplacementCapacityNode(
  tx: DbTransaction,
  locator: ValidatedLocator,
  reference: ValidatedReference,
) {
  const [node] = await tx
    .select()
    .from(dockerNodes)
    .where(
      and(
        eq(dockerNodes.id, locator.nodeRecordId),
        eq(dockerNodes.node_id, locator.nodeId),
        eq(dockerNodes.node_incarnation, locator.nodeIncarnation),
        eq(dockerNodes.current_node_history_id, locator.nodeHistoryId),
        eq(dockerNodes.hostname, locator.nodeHostname),
        eq(dockerNodes.ssh_port, locator.nodeSshPort),
        eq(dockerNodes.ssh_user, locator.nodeSshUser),
        eq(dockerNodes.host_key_fingerprint, locator.nodeHostKeyFingerprint),
      ),
    )
    .for("update")
    .limit(1);
  if (!node) {
    throw conflict("Replacement Docker-node occurrence does not match", reference);
  }
  return node;
}

function restoreOperationMatchesReplacementAuthority(
  restoreOperation: AgentBackupRestoreOperation,
  attempt: AgentSandboxReplacementAttempt,
  locator: ValidatedLocator,
): boolean {
  return (
    restoreOperation.organization_id === attempt.organization_id &&
    restoreOperation.agent_id === attempt.agent_id &&
    restoreOperation.restore_attempt_id === attempt.restore_attempt_id &&
    restoreOperation.backup_id === attempt.restore_backup_id &&
    restoreOperation.lease_id === attempt.restore_lease_id &&
    restoreOperation.lease_generation === attempt.restore_lease_generation &&
    restoreOperation.lease_owner_id === attempt.restore_lease_owner_id &&
    restoreOperation.catalog_epoch === attempt.restore_catalog_epoch &&
    restoreOperation.copy_role === attempt.restore_copy_role &&
    restoreOperation.expected_operation_id === attempt.restore_operation_id &&
    restoreOperation.expected_activation_generation ===
      attempt.restore_source_activation_generation &&
    restoreOperation.expected_lifecycle_revision === attempt.restore_source_lifecycle_revision &&
    restoreOperation.expected_manifest_sha256 === attempt.restore_manifest_sha256 &&
    restoreOperation.expected_node_record_id === locator.nodeRecordId &&
    restoreOperation.expected_node_id === locator.nodeId &&
    restoreOperation.expected_node_incarnation === locator.nodeIncarnation &&
    restoreOperation.expected_node_history_id === locator.nodeHistoryId
  );
}

async function lockRestoreHandoffLease(
  tx: DbTransaction,
  restoreOperation: AgentBackupRestoreOperation,
  reference: ValidatedReference,
): Promise<AgentBackupRestoreLease> {
  const [lease] = await tx
    .select()
    .from(agentBackupRestoreLeases)
    .where(
      and(
        eq(agentBackupRestoreLeases.id, restoreOperation.lease_id),
        eq(agentBackupRestoreLeases.organization_id, restoreOperation.organization_id),
        eq(agentBackupRestoreLeases.agent_id, restoreOperation.agent_id),
        eq(agentBackupRestoreLeases.backup_id, restoreOperation.backup_id),
        eq(agentBackupRestoreLeases.restore_attempt_id, restoreOperation.restore_attempt_id),
        eq(agentBackupRestoreLeases.generation, restoreOperation.lease_generation),
        eq(agentBackupRestoreLeases.owner_id, restoreOperation.lease_owner_id),
        eq(agentBackupRestoreLeases.catalog_epoch, restoreOperation.catalog_epoch),
        eq(agentBackupRestoreLeases.copy_role, restoreOperation.copy_role),
        eq(agentBackupRestoreLeases.operation_id, restoreOperation.expected_operation_id),
        eq(
          agentBackupRestoreLeases.activation_generation,
          restoreOperation.expected_activation_generation,
        ),
        eq(
          agentBackupRestoreLeases.lifecycle_revision,
          restoreOperation.expected_lifecycle_revision,
        ),
        eq(
          agentBackupRestoreLeases.expected_manifest_sha256,
          restoreOperation.expected_manifest_sha256,
        ),
      ),
    )
    .for("update")
    .limit(1);
  if (!lease) {
    throw conflict("Restore lease fence was lost during capacity handoff", reference);
  }
  return lease;
}

function assertLiveRestoreHandoffAuthority(
  restoreOperation: AgentBackupRestoreOperation,
  lease: AgentBackupRestoreLease,
  capacityIntent: Extract<ValidatedCapacityIntent, { kind: "restore_handoff" }>,
  databaseNow: Date,
  reference: ValidatedReference,
): void {
  if (
    lease.released_at !== null ||
    lease.expires_at <= databaseNow ||
    restoreOperation.claim_owner !== restoreOperation.lease_owner_id ||
    restoreOperation.claim_generation !== capacityIntent.restoreClaimGeneration ||
    restoreOperation.claim_expires_at === null ||
    restoreOperation.claim_expires_at <= databaseNow
  ) {
    throw conflict("Restore capacity handoff claim or lease is not live", reference);
  }
}

function assertReservedReplacementTargetUsable(
  node: Awaited<ReturnType<typeof lockReplacementCapacityNode>>,
  reference: ValidatedReference,
): void {
  if (
    !node.enabled ||
    node.status !== "healthy" ||
    node.placement_state !== PLACEABLE_NODE_STATE ||
    node.metadata.capacityProvisional === true ||
    node.allocated_count < 1
  ) {
    throw conflict("Reserved replacement target is no longer usable", reference);
  }
}

function replacementIntentValues(locator: ValidatedLocator, databaseNow: Date) {
  return {
    locator_sandbox_id: locator.sandboxId,
    locator_node_id: locator.nodeId,
    locator_container_name: locator.containerName,
    locator_node_record_id: locator.nodeRecordId,
    locator_node_incarnation: locator.nodeIncarnation,
    locator_node_history_id: locator.nodeHistoryId,
    locator_node_hostname: locator.nodeHostname,
    locator_node_ssh_port: locator.nodeSshPort,
    locator_node_ssh_user: locator.nodeSshUser,
    locator_node_host_key_fingerprint: locator.nodeHostKeyFingerprint,
    locator_secret_cleanup_version: locator.replacementSecretCleanupVersion,
    locator_allocation_counted: locator.allocationCounted,
    locator_vpn_node_name: locator.vpnNodeName,
    locator_vpn_registration_started_at: locator.vpnRegistrationStartedAt,
    locator_previous_vpn_node_id: locator.previousVpnNodeId,
    locator_recorded_at: databaseNow,
    capacity_state: "reserved" as const,
    capacity_reserved_at: databaseNow,
    updated_at: databaseNow,
  };
}

async function recordCapacityOwnedReplacementIntentInTransaction(
  tx: DbTransaction,
  reference: ValidatedReference,
  locator: ValidatedLocator,
  capacityIntent: ValidatedCapacityIntent,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  // Restore handoff must lock the source operation before the receiver attempt.
  // Standalone attempts have no source and retain the ordinary attempt -> node
  // order shared by adoption and cleanup.
  const [restoreOperation] =
    capacityIntent.kind === "restore_handoff"
      ? await tx
          .select()
          .from(agentBackupRestoreOperations)
          .where(
            and(
              eq(agentBackupRestoreOperations.id, capacityIntent.restoreOperationId),
              eq(agentBackupRestoreOperations.organization_id, reference.organizationId),
              eq(agentBackupRestoreOperations.agent_id, reference.agentId),
            ),
          )
          .for("update")
          .limit(1)
      : [undefined];
  if (capacityIntent.kind === "restore_handoff" && !restoreOperation) {
    throw conflict("Restore capacity source operation is missing", reference);
  }

  const current = await lockAttempt(tx, reference);
  assertCallbackStageOpen(current, reference);
  if (current.previous_placement_absent === null) {
    throw conflict("Replacement intent has no classified previous placement", reference);
  }
  if (
    current.previous_placement_absent === false &&
    (current.previous_node_id === locator.nodeId ||
      current.previous_node_record_id === locator.nodeRecordId)
  ) {
    throw conflict("Replacement target must differ from the previous Docker node", reference);
  }
  const restoreLinked = current.restore_attempt_id !== null;
  if ((capacityIntent.kind === "restore_handoff") !== restoreLinked) {
    throw conflict("Replacement capacity intent kind does not match restore authority", reference);
  }

  if (hasLocator(current)) {
    assertLocatorCoreMatches(current, locator, reference);
    if (current.capacity_state !== "reserved" || current.capacity_reserved_at === null) {
      throw conflict("Replacement capacity replay is not reserved", reference, current.state);
    }
    if (current.state !== "in_flight_unresolved") {
      throw conflict(
        "Replacement intent already advanced; resume from its durable state",
        reference,
        current.state,
      );
    }
    if (capacityIntent.kind === "restore_handoff") {
      if (
        !restoreOperation ||
        !restoreOperationMatchesReplacementAuthority(restoreOperation, current, locator) ||
        restoreOperation.capacity_state !== "handed_off" ||
        restoreOperation.capacity_settlement_receipt_digest !== capacityIntent.receiptDigest ||
        restoreOperation.capacity_settled_at?.getTime() !== current.capacity_reserved_at.getTime()
      ) {
        throw conflict("Restore capacity handoff replay mismatch", reference, current.state);
      }
      const lease = await lockRestoreHandoffLease(tx, restoreOperation, reference);
      const node = await lockReplacementCapacityNode(tx, locator, reference);
      const databaseNow = await readPostLockDatabaseNow(tx);
      assertLiveRestoreHandoffAuthority(
        restoreOperation,
        lease,
        capacityIntent,
        databaseNow,
        reference,
      );
      assertReservedReplacementTargetUsable(node, reference);
    } else {
      const node = await lockReplacementCapacityNode(tx, locator, reference);
      assertReservedReplacementTargetUsable(node, reference);
    }
    return frozenResult(current, true);
  }
  if (
    current.capacity_state !== null ||
    current.capacity_reserved_at !== null ||
    current.capacity_settled_at !== null ||
    current.capacity_settlement_receipt_digest !== null
  ) {
    throw conflict(
      "Replacement capacity authority is only partially set",
      reference,
      current.state,
    );
  }

  if (capacityIntent.kind === "restore_handoff") {
    if (
      !restoreOperation ||
      !restoreOperationMatchesReplacementAuthority(restoreOperation, current, locator) ||
      restoreOperation.capacity_state !== "reserved" ||
      restoreOperation.capacity_reserved_at === null
    ) {
      throw conflict("Restore capacity source does not match replacement intent", reference);
    }

    const lease = await lockRestoreHandoffLease(tx, restoreOperation, reference);
    const node = await lockReplacementCapacityNode(tx, locator, reference);
    const databaseNow = await readPostLockDatabaseNow(tx);
    assertLiveRestoreHandoffAuthority(
      restoreOperation,
      lease,
      capacityIntent,
      databaseNow,
      reference,
    );
    assertReservedReplacementTargetUsable(node, reference);

    const [handedOff] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        capacity_state: "handed_off",
        capacity_settled_at: databaseNow,
        capacity_settlement_receipt_digest: capacityIntent.receiptDigest,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, restoreOperation.id),
          eq(agentBackupRestoreOperations.capacity_state, "reserved"),
          eq(agentBackupRestoreOperations.claim_generation, capacityIntent.restoreClaimGeneration),
        ),
      )
      .returning({ id: agentBackupRestoreOperations.id });
    if (!handedOff) {
      throw conflict("Restore capacity handoff lost its source CAS", reference);
    }

    const [recorded] = await tx
      .update(agentSandboxReplacementAttempts)
      .set(replacementIntentValues(locator, databaseNow))
      .where(
        and(
          eq(agentSandboxReplacementAttempts.id, reference.attemptId),
          eq(agentSandboxReplacementAttempts.organization_id, reference.organizationId),
          eq(agentSandboxReplacementAttempts.agent_id, reference.agentId),
          eq(agentSandboxReplacementAttempts.state, "in_flight_unresolved"),
          sql`${agentSandboxReplacementAttempts.locator_recorded_at} IS NULL`,
          sql`${agentSandboxReplacementAttempts.capacity_state} IS NULL`,
        ),
      )
      .returning();
    if (!recorded) {
      throw conflict("Restore capacity handoff lost its receiver CAS", reference);
    }
    return frozenResult(recorded, false);
  }

  const node = await lockReplacementCapacityNode(tx, locator, reference);
  const databaseNow = await readPostLockDatabaseNow(tx);
  if (
    !node.enabled ||
    node.status !== "healthy" ||
    node.placement_state !== PLACEABLE_NODE_STATE ||
    node.metadata.capacityProvisional === true ||
    node.allocated_count >= node.capacity
  ) {
    throw conflict("Standalone replacement target has no reservable capacity", reference);
  }
  const [reservedNode] = await tx
    .update(dockerNodes)
    .set({
      allocated_count: sql`${dockerNodes.allocated_count} + 1`,
      updated_at: databaseNow,
    })
    .where(
      and(
        eq(dockerNodes.id, locator.nodeRecordId),
        eq(dockerNodes.node_id, locator.nodeId),
        eq(dockerNodes.node_incarnation, locator.nodeIncarnation),
        eq(dockerNodes.current_node_history_id, locator.nodeHistoryId),
        eq(dockerNodes.enabled, true),
        eq(dockerNodes.status, "healthy"),
        eq(dockerNodes.placement_state, PLACEABLE_NODE_STATE),
        sql`COALESCE(${dockerNodes.metadata}->>'capacityProvisional', 'false') <> 'true'`,
        sql`${dockerNodes.allocated_count} < ${dockerNodes.capacity}`,
      ),
    )
    .returning({ id: dockerNodes.id });
  if (!reservedNode) {
    throw conflict("Standalone replacement capacity reservation lost its node CAS", reference);
  }
  const [recorded] = await tx
    .update(agentSandboxReplacementAttempts)
    .set(replacementIntentValues(locator, databaseNow))
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, reference.attemptId),
        eq(agentSandboxReplacementAttempts.organization_id, reference.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, reference.agentId),
        eq(agentSandboxReplacementAttempts.state, "in_flight_unresolved"),
        sql`${agentSandboxReplacementAttempts.locator_recorded_at} IS NULL`,
        sql`${agentSandboxReplacementAttempts.capacity_state} IS NULL`,
      ),
    )
    .returning();
  if (!recorded) {
    throw conflict("Standalone replacement capacity reservation lost its owner CAS", reference);
  }
  return frozenResult(recorded, false);
}

async function recordLocatorStageInTransaction(
  tx: DbTransaction,
  referenceInput: AgentSandboxReplacementAttemptReference,
  locatorInput: AgentSandboxReplacementLocatorInput,
  stage: "intent" | "created" | "vpn",
  capacityIntentInput?: AgentSandboxReplacementCapacityIntent,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  const reference = validateReference(referenceInput);
  const locator = validateLocator(locatorInput, reference, stage);
  if (stage === "intent") {
    if (!capacityIntentInput) {
      throw invalidInput("capacityIntent is required for replacement intent", "capacityIntent");
    }
    return await recordCapacityOwnedReplacementIntentInTransaction(
      tx,
      reference,
      locator,
      validateCapacityIntent(capacityIntentInput),
    );
  }
  const current = await lockAttempt(tx, reference);
  assertCallbackStageOpen(current, reference);
  const databaseNow = await readPostLockDatabaseNow(tx);

  if (!hasLocator(current)) {
    throw conflict(
      "Replacement enrichment arrived before durable intent",
      reference,
      current.state,
    );
  }
  assertLocatorCoreMatches(current, locator, reference);
  if (!locator.containerId) {
    throw invalidInput("Created replacement locator is missing containerId", "locator.containerId");
  }
  if (current.locator_container_id !== null) {
    assertContainerMatches(current, locator.containerId, reference);
    if (stage === "created") return frozenResult(current, true);
  }

  if (stage === "created") {
    const [recorded] = await tx
      .update(agentSandboxReplacementAttempts)
      .set({
        locator_container_id: locator.containerId,
        locator_container_recorded_at: databaseNow,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentSandboxReplacementAttempts.id, reference.attemptId),
          eq(agentSandboxReplacementAttempts.organization_id, reference.organizationId),
          eq(agentSandboxReplacementAttempts.agent_id, reference.agentId),
          eq(agentSandboxReplacementAttempts.state, "in_flight_unresolved"),
        ),
      )
      .returning();
    if (!recorded) {
      throw conflict("Replacement Docker enrichment lost its state CAS", reference, current.state);
    }
    return frozenResult(recorded, false);
  }

  if (!locator.vpnNodeId) {
    throw invalidInput("VPN replacement locator is missing vpnNodeId", "locator.vpnNodeId");
  }
  if (current.locator_container_id === null) {
    throw conflict(
      "Replacement VPN enrichment arrived before Docker enrichment",
      reference,
      current.state,
    );
  }
  assertContainerMatches(current, locator.containerId, reference);
  if (current.locator_vpn_node_id !== null) {
    assertVpnMatches(current, locator.vpnNodeId, reference);
    return frozenResult(current, true);
  }
  const [recorded] = await tx
    .update(agentSandboxReplacementAttempts)
    .set({
      locator_vpn_node_id: locator.vpnNodeId,
      locator_vpn_recorded_at: databaseNow,
      updated_at: databaseNow,
    })
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, reference.attemptId),
        eq(agentSandboxReplacementAttempts.organization_id, reference.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, reference.agentId),
        eq(agentSandboxReplacementAttempts.state, "in_flight_unresolved"),
      ),
    )
    .returning();
  if (!recorded) {
    throw conflict("Replacement VPN enrichment lost its state CAS", reference, current.state);
  }
  return frozenResult(recorded, false);
}

/** Persist pre-create placement inside the caller's capacity-reservation transaction. */
export async function recordAgentSandboxReplacementIntentInTransaction(
  tx: DbTransaction,
  reference: AgentSandboxReplacementAttemptReference,
  locator: AgentSandboxReplacementLocatorInput,
  capacityIntent: AgentSandboxReplacementCapacityIntent,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  return await recordLocatorStageInTransaction(tx, reference, locator, "intent", capacityIntent);
}

/** Write-once Docker ID enrichment for the exact intent. */
export async function recordAgentSandboxReplacementCreatedInTransaction(
  tx: DbTransaction,
  reference: AgentSandboxReplacementAttemptReference,
  locator: AgentSandboxReplacementLocatorInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  return await recordLocatorStageInTransaction(tx, reference, locator, "created");
}

/** Write-once Docker ID enrichment with a repository-owned transaction. */
export async function recordAgentSandboxReplacementCreated(
  reference: AgentSandboxReplacementAttemptReference,
  locator: AgentSandboxReplacementLocatorInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  return await dbWrite.transaction((tx) =>
    recordAgentSandboxReplacementCreatedInTransaction(tx, reference, locator),
  );
}

/** Write-once Headscale ID enrichment for the exact created container. */
export async function recordAgentSandboxReplacementVpnRegisteredInTransaction(
  tx: DbTransaction,
  reference: AgentSandboxReplacementAttemptReference,
  locator: AgentSandboxReplacementLocatorInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  return await recordLocatorStageInTransaction(tx, reference, locator, "vpn");
}

/** Write-once Headscale ID enrichment with a repository-owned transaction. */
export async function recordAgentSandboxReplacementVpnRegistered(
  reference: AgentSandboxReplacementAttemptReference,
  locator: AgentSandboxReplacementLocatorInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  return await dbWrite.transaction((tx) =>
    recordAgentSandboxReplacementVpnRegisteredInTransaction(tx, reference, locator),
  );
}

/**
 * Retain proven provider success as an active fence until lifecycle adoption or
 * exact cleanup terminates it. Same-digest response-loss replay is idempotent.
 */
export async function recordAgentSandboxReplacementProviderSucceeded(
  referenceInput: AgentSandboxReplacementAttemptReference,
  locatorInput: AgentSandboxReplacementLocatorInput,
  receiptDigestInput: string,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  const reference = validateReference(referenceInput);
  const locator = validateLocator(locatorInput, reference, "final");
  const receiptDigest = requireSha256(receiptDigestInput, "receiptDigest");
  return await dbWrite.transaction(async (tx) => {
    const current = await lockAttempt(tx, reference);
    if (current.state === "provider_succeeded") {
      assertLocatorCoreMatches(current, locator, reference);
      assertContainerMatches(current, locator.containerId!, reference);
      assertVpnMatches(current, locator.vpnNodeId, reference);
      if (current.provider_receipt_digest !== receiptDigest) {
        throw conflict("Provider-success receipt replay mismatch", reference, current.state);
      }
      return frozenResult(current, true);
    }
    if (current.state !== "in_flight_unresolved") {
      throw conflict(
        "Provider success cannot advance a terminal attempt",
        reference,
        current.state,
      );
    }
    assertLocatorCoreMatches(current, locator, reference);
    assertContainerMatches(current, locator.containerId!, reference);
    assertVpnMatches(current, locator.vpnNodeId, reference);
    const databaseNow = await readPostLockDatabaseNow(tx);
    const [recorded] = await tx
      .update(agentSandboxReplacementAttempts)
      .set({
        state: "provider_succeeded",
        provider_succeeded_at: databaseNow,
        provider_receipt_digest: receiptDigest,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentSandboxReplacementAttempts.id, reference.attemptId),
          eq(agentSandboxReplacementAttempts.organization_id, reference.organizationId),
          eq(agentSandboxReplacementAttempts.agent_id, reference.agentId),
          eq(agentSandboxReplacementAttempts.state, "in_flight_unresolved"),
        ),
      )
      .returning();
    if (!recorded) {
      throw conflict("Provider-success settlement lost its state CAS", reference, current.state);
    }
    return frozenResult(recorded, false);
  });
}

/**
 * Atomically adopt exact provider success into the canonical sandbox and retain
 * its locked pre-state placement for cleanup. This helper never starts or
 * commits a transaction; a later caller failure rolls both writes back and
 * keeps `provider_succeeded` visibly active.
 */
export async function commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
  tx: DbTransaction,
  input: CommitAgentSandboxReplacementLifecycleAdoptionInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  const expected = validateStart(input);
  const locator = validateLocator(input.locator, expected, "final");
  const previousPlacement = validatePreviousPlacement(input.previousPlacement);
  const canonicalPatch = validateCanonicalPatch(input.canonicalPatch);
  const providerReceiptDigest = requireSha256(input.providerReceiptDigest, "providerReceiptDigest");
  const lifecycleReceiptDigest = requireSha256(
    input.lifecycleReceiptDigest,
    "lifecycleReceiptDigest",
  );
  // The active-generation insert path locks sandbox before touching the unique
  // fence. Keep the same order here so adoption cannot deadlock with a new start.
  const sandbox = await lockAgentSandboxAuthority(tx, expected);
  const current = await lockAttempt(tx, expected);
  assertStartAuthorityMatches(current, expected);
  if (
    current.previous_placement_absent !== (previousPlacement === null) ||
    (previousPlacement === null && expected.operationKind !== "provision")
  ) {
    throw conflict("Lifecycle adoption previous-placement mode does not match", expected);
  }
  const durablePreviousAuthority = previousPlacementAuthorityFromAttempt(
    current,
    previousPlacement,
    expected,
  );
  assertLocatorCoreMatches(current, locator, expected);
  assertContainerMatches(current, locator.containerId!, expected);
  assertVpnMatches(current, locator.vpnNodeId, expected);
  if (current.provider_receipt_digest !== providerReceiptDigest) {
    throw conflict("Provider receipt does not match lifecycle adoption", expected, current.state);
  }
  if (current.state === "lifecycle_committed") {
    if (
      current.lifecycle_receipt_digest !== lifecycleReceiptDigest ||
      current.lifecycle_committed_at === null ||
      current.capacity_state !== "handed_off" ||
      current.capacity_settlement_receipt_digest !== lifecycleReceiptDigest ||
      current.capacity_settled_at?.getTime() !== current.lifecycle_committed_at.getTime() ||
      (previousPlacement === null
        ? current.previous_cleanup_state !== null ||
          current.previous_cleanup_proven_at !== null ||
          current.previous_cleanup_receipt_digest !== null
        : current.previous_cleanup_state !== "pending" &&
          current.previous_cleanup_state !== "released")
    ) {
      throw conflict("Lifecycle receipt replay mismatch", expected, current.state);
    }
    assertAgentSandboxLifecycleAdoptionPostState(
      sandbox,
      expected,
      locator,
      previousPlacement,
      canonicalPatch,
      current.lifecycle_committed_at,
      durablePreviousAuthority,
      current.previous_cleanup_state,
    );
    return frozenResult(current, true);
  }
  if (current.state !== "provider_succeeded") {
    throw conflict("Lifecycle commit requires provider success", expected, current.state);
  }
  if (current.capacity_state !== "reserved" || current.capacity_reserved_at === null) {
    throw conflict("Lifecycle commit requires reserved replacement capacity", expected);
  }
  const cleanupFenceMode = assertCandidateOrEmptyCleanupFence(sandbox, current, locator, expected);
  assertCanonicalPatchMatchesPreState(sandbox, expected, previousPlacement, canonicalPatch);
  assertAgentSandboxLifecycleAdoptionPreState(
    sandbox,
    expected,
    previousPlacement,
    cleanupFenceMode,
  );
  const previousAuthority = await lockAndValidateReplacementAndPreviousNodeAuthorities(
    tx,
    locator,
    previousPlacement,
    current,
    expected,
  );
  const databaseNow = await readPostLockDatabaseNow(tx);
  const [adoptedSandbox] = await tx
    .update(agentSandboxes)
    .set({
      sandbox_id: locator.sandboxId,
      node_id: locator.nodeId,
      container_name: locator.containerName,
      replacement_cleanup_sandbox_id: sandbox.sandboxId,
      replacement_cleanup_node_id: sandbox.nodeId,
      replacement_cleanup_node_record_id: previousAuthority?.nodeRecordId ?? null,
      replacement_cleanup_node_incarnation: previousAuthority?.nodeIncarnation ?? null,
      replacement_cleanup_node_history_id: previousAuthority?.nodeHistoryId ?? null,
      replacement_cleanup_node_hostname: previousAuthority?.nodeHostname ?? null,
      replacement_cleanup_node_ssh_port: previousAuthority?.nodeSshPort ?? null,
      replacement_cleanup_node_ssh_user: previousAuthority?.nodeSshUser ?? null,
      replacement_cleanup_node_host_key_fingerprint:
        previousAuthority?.nodeHostKeyFingerprint ?? null,
      // The handoff attempt remains the immutable DB correlation fence, but
      // the retired primary must never inherit candidate secret-cleanup v1.
      replacement_cleanup_secret_cleanup_version: null,
      replacement_cleanup_container_name: previousPlacement?.containerName ?? null,
      replacement_cleanup_attempt_id: previousPlacement === null ? null : expected.attemptId,
      replacement_cleanup_container_id: previousAuthority?.containerId ?? null,
      replacement_cleanup_vpn_node_id:
        previousPlacement === null ? null : locator.previousVpnNodeId,
      replacement_cleanup_vpn_node_name: null,
      replacement_cleanup_preserved_vpn_node_id: null,
      replacement_cleanup_vpn_registration_started_at: null,
      replacement_cleanup_allocation_counted: previousPlacement?.allocationCounted ?? null,
      replacement_cleanup_created_at: previousPlacement === null ? null : databaseNow,
      status: canonicalPatch.status,
      bridge_url: canonicalPatch.bridgeUrl,
      health_url: canonicalPatch.healthUrl,
      last_heartbeat_at: canonicalPatch.lastHeartbeatAt,
      error_message: canonicalPatch.errorMessage,
      bridge_port: canonicalPatch.bridgePort,
      web_ui_port: canonicalPatch.webUiPort,
      headscale_ip: canonicalPatch.headscaleIp,
      docker_image: canonicalPatch.dockerImage,
      image_digest: canonicalPatch.imageDigest,
      previous_docker_image: canonicalPatch.previousDockerImage,
      previous_image_digest: canonicalPatch.previousImageDigest,
      updated_at: databaseNow,
    })
    .where(
      and(
        eq(agentSandboxes.id, expected.agentId),
        eq(agentSandboxes.organization_id, expected.organizationId),
        sql`${agentSandboxes.lifecycle_revision} = ${sandbox.lifecycleRevision}::numeric`,
        eq(agentSandboxes.activation_generation, expected.activationGeneration),
        sql`${agentSandboxes.lifecycle_job_id} IS NOT DISTINCT FROM ${expected.lifecycleJobId}`,
        sql`${agentSandboxes.lifecycle_execution_generation}
          IS NOT DISTINCT FROM ${expected.lifecycleExecutionGeneration}`,
        previousPlacement === null
          ? sql`${agentSandboxes.sandbox_id} IS NULL`
          : eq(agentSandboxes.sandbox_id, previousPlacement.sandboxId),
        previousPlacement === null
          ? sql`${agentSandboxes.node_id} IS NULL`
          : eq(agentSandboxes.node_id, previousPlacement.nodeId),
        previousPlacement === null
          ? sql`${agentSandboxes.container_name} IS NULL`
          : eq(agentSandboxes.container_name, previousPlacement.containerName),
        sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
        sql`(
          ${agentSandboxes.deletion_allocation_counted} IS TRUE
          OR (
            ${agentSandboxes.deletion_allocation_counted} IS NULL
            AND ${agentSandboxes.status}
              NOT IN ('stopped', 'error', 'sleeping', 'deletion_failed')
          )
        )`,
      ),
    )
    .returning({ id: agentSandboxes.id });
  if (!adoptedSandbox) {
    throw conflict("Canonical sandbox lifecycle adoption lost its pre-state CAS", expected);
  }
  const [recorded] = await tx
    .update(agentSandboxReplacementAttempts)
    .set({
      state: "lifecycle_committed",
      lifecycle_committed_at: databaseNow,
      lifecycle_receipt_digest: lifecycleReceiptDigest,
      capacity_state: "handed_off",
      capacity_settled_at: databaseNow,
      capacity_settlement_receipt_digest: lifecycleReceiptDigest,
      previous_cleanup_state: previousPlacement === null ? null : "pending",
      previous_cleanup_proven_at: null,
      previous_cleanup_receipt_digest: null,
      updated_at: databaseNow,
    })
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, expected.attemptId),
        eq(agentSandboxReplacementAttempts.organization_id, expected.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, expected.agentId),
        eq(agentSandboxReplacementAttempts.state, "provider_succeeded"),
        eq(agentSandboxReplacementAttempts.capacity_state, "reserved"),
      ),
    )
    .returning();
  if (!recorded) {
    throw conflict("Lifecycle commit lost its state CAS", expected, current.state);
  }
  assertAgentSandboxLifecycleAdoptionPostState(
    await lockAgentSandboxAuthority(tx, expected),
    expected,
    locator,
    previousPlacement,
    canonicalPatch,
    databaseNow,
    previousAuthority,
    recorded.previous_cleanup_state,
  );
  return frozenResult(recorded, false);
}

/**
 * Settle the retired primary retained by lifecycle adoption. The caller MUST
 * clear the exact `replacement_cleanup_*` fence later in this same transaction;
 * committing a released receipt while leaving that fence is not a valid final
 * state. Same-receipt replay is accepted only after the fence is fully clear.
 */
export async function recordAgentSandboxReplacementPreviousCleanupProvenInTransaction(
  tx: DbTransaction,
  referenceInput: AgentSandboxReplacementAttemptReference,
  receiptDigestInput: string,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  const reference = validateReference(referenceInput);
  const receiptDigest = requireSha256(receiptDigestInput, "receiptDigest");
  // Preserve the global lifecycle order: sandbox -> attempt -> immutable node.
  const sandbox = await lockAgentSandboxAuthority(tx, reference);
  const current = await lockAttempt(tx, reference);
  if (
    current.state !== "lifecycle_committed" ||
    current.capacity_state !== "handed_off" ||
    current.previous_placement_absent !== false ||
    current.lifecycle_committed_at === null ||
    current.previous_node_record_id === null ||
    current.previous_node_id === null ||
    current.previous_node_incarnation === null ||
    current.previous_node_history_id === null ||
    current.previous_container_id === null ||
    !CANONICAL_FULL_CONTAINER_ID.test(current.previous_container_id) ||
    current.previous_allocation_counted !== true
  ) {
    throw conflict("Previous-primary cleanup has no committed exact authority", reference);
  }
  if (current.previous_cleanup_state === "released") {
    if (
      current.previous_cleanup_receipt_digest !== receiptDigest ||
      current.previous_cleanup_proven_at === null ||
      hasAnyReplacementCleanupAuthority(sandbox)
    ) {
      throw conflict("Previous-primary cleanup receipt replay mismatch", reference, current.state);
    }
    return frozenResult(current, true);
  }
  if (
    current.previous_cleanup_state !== "pending" ||
    current.previous_cleanup_proven_at !== null ||
    current.previous_cleanup_receipt_digest !== null ||
    !oldPrimaryCleanupFenceMatches(sandbox, current)
  ) {
    throw conflict("Previous-primary cleanup fence does not match its attempt", reference);
  }

  const [previousNode] = await tx
    .select()
    .from(dockerNodes)
    .where(eq(dockerNodes.id, current.previous_node_record_id))
    .for("update")
    .limit(1);
  const previousOccurrenceIsCurrent = Boolean(
    previousNode &&
      previousNode.node_id === current.previous_node_id &&
      previousNode.node_incarnation === current.previous_node_incarnation &&
      previousNode.current_node_history_id === current.previous_node_history_id,
  );
  if (previousOccurrenceIsCurrent && previousNode!.allocated_count < 1) {
    throw conflict("Previous-primary cleanup capacity counter is already empty", reference);
  }
  const databaseNow = await readPostLockDatabaseNow(tx);
  if (previousOccurrenceIsCurrent) {
    const [releasedNode] = await tx
      .update(dockerNodes)
      .set({
        allocated_count: sql`${dockerNodes.allocated_count} - 1`,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(dockerNodes.id, current.previous_node_record_id),
          eq(dockerNodes.node_id, current.previous_node_id),
          eq(dockerNodes.node_incarnation, current.previous_node_incarnation),
          eq(dockerNodes.current_node_history_id, current.previous_node_history_id),
          sql`${dockerNodes.allocated_count} > 0`,
        ),
      )
      .returning({ id: dockerNodes.id });
    if (!releasedNode) {
      throw conflict("Previous-primary cleanup capacity release lost its node CAS", reference);
    }
  }
  const [recorded] = await tx
    .update(agentSandboxReplacementAttempts)
    .set({
      previous_cleanup_state: "released",
      previous_cleanup_proven_at: databaseNow,
      previous_cleanup_receipt_digest: receiptDigest,
      updated_at: databaseNow,
    })
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, reference.attemptId),
        eq(agentSandboxReplacementAttempts.organization_id, reference.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, reference.agentId),
        eq(agentSandboxReplacementAttempts.state, "lifecycle_committed"),
        eq(agentSandboxReplacementAttempts.previous_cleanup_state, "pending"),
      ),
    )
    .returning();
  if (!recorded) {
    throw conflict("Previous-primary cleanup settlement lost its attempt CAS", reference);
  }
  return frozenResult(recorded, false);
}

/**
 * Terminally retain exact cleanup proof. It may close an unresolved call or a
 * provider-success candidate rejected before lifecycle adoption. The exact
 * current occurrence is decremented here; a retired occurrence settles only
 * its retained owner and can never decrement a replacement node's counter.
 */
export async function recordAgentSandboxReplacementCleanupProvenInTransaction(
  tx: DbTransaction,
  referenceInput: AgentSandboxReplacementAttemptReference,
  receiptDigestInput: string,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  const reference = validateReference(referenceInput);
  const receiptDigest = requireSha256(receiptDigestInput, "receiptDigest");
  // A cleanup commit releases the partial-unique fence. Lock sandbox before the
  // attempt so a concurrent start follows the same sandbox -> fence order.
  await lockAgentSandboxAuthority(tx, reference);
  const current = await lockAttempt(tx, reference);
  if (current.state === "cleanup_proven") {
    if (
      current.cleanup_receipt_digest !== receiptDigest ||
      (hasLocator(current)
        ? current.capacity_state !== "released" ||
          current.capacity_settlement_receipt_digest !== receiptDigest
        : current.capacity_state !== null)
    ) {
      throw conflict("Cleanup receipt replay mismatch", reference, current.state);
    }
    return frozenResult(current, true);
  }
  if (current.state !== "in_flight_unresolved" && current.state !== "provider_succeeded") {
    throw conflict("Cleanup proof cannot replace lifecycle commitment", reference, current.state);
  }
  const ownsCapacity = hasLocator(current);
  if (
    ownsCapacity
      ? current.capacity_state !== "reserved" || current.capacity_reserved_at === null
      : current.capacity_state !== null || current.capacity_reserved_at !== null
  ) {
    throw conflict(
      "Cleanup capacity ownership does not match its locator",
      reference,
      current.state,
    );
  }
  let exactCurrentCapacityNode = false;
  if (ownsCapacity) {
    const [node] = await tx
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, current.locator_node_record_id!))
      .for("update")
      .limit(1);
    exactCurrentCapacityNode = Boolean(
      node &&
        node.node_id === current.locator_node_id &&
        node.node_incarnation === current.locator_node_incarnation &&
        node.current_node_history_id === current.locator_node_history_id,
    );
    if (node && exactCurrentCapacityNode && node.allocated_count < 1) {
      throw conflict("Replacement cleanup capacity counter is already empty", reference);
    }
  }
  const databaseNow = await readPostLockDatabaseNow(tx);
  if (ownsCapacity && exactCurrentCapacityNode) {
    const [releasedNode] = await tx
      .update(dockerNodes)
      .set({
        allocated_count: sql`${dockerNodes.allocated_count} - 1`,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(dockerNodes.id, current.locator_node_record_id!),
          eq(dockerNodes.node_id, current.locator_node_id!),
          eq(dockerNodes.node_incarnation, current.locator_node_incarnation!),
          eq(dockerNodes.current_node_history_id, current.locator_node_history_id!),
          sql`${dockerNodes.allocated_count} > 0`,
        ),
      )
      .returning({ id: dockerNodes.id });
    if (!releasedNode) {
      throw conflict("Replacement cleanup capacity release lost its node CAS", reference);
    }
  }
  const [recorded] = await tx
    .update(agentSandboxReplacementAttempts)
    .set({
      state: "cleanup_proven",
      cleanup_proven_at: databaseNow,
      cleanup_receipt_digest: receiptDigest,
      ...(ownsCapacity
        ? {
            capacity_state: "released" as const,
            capacity_settled_at: databaseNow,
            capacity_settlement_receipt_digest: receiptDigest,
          }
        : {}),
      updated_at: databaseNow,
    })
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, reference.attemptId),
        eq(agentSandboxReplacementAttempts.organization_id, reference.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, reference.agentId),
        eq(agentSandboxReplacementAttempts.state, current.state),
        ownsCapacity
          ? eq(agentSandboxReplacementAttempts.capacity_state, "reserved")
          : sql`${agentSandboxReplacementAttempts.capacity_state} IS NULL`,
      ),
    )
    .returning();
  if (!recorded) {
    throw conflict("Cleanup settlement lost its state CAS", reference, current.state);
  }
  return frozenResult(recorded, false);
}

/** Primary read of retained replacement authority; no age-based filtering. */
export async function getAgentSandboxReplacementAttempt(
  referenceInput: AgentSandboxReplacementAttemptReference,
): Promise<Readonly<AgentSandboxReplacementAttempt> | null> {
  const reference = validateReference(referenceInput);
  const [attempt] = await dbWrite
    .select()
    .from(agentSandboxReplacementAttempts)
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, reference.attemptId),
        eq(agentSandboxReplacementAttempts.organization_id, reference.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, reference.agentId),
      ),
    )
    .limit(1);
  return attempt ? Object.freeze(attempt) : null;
}
