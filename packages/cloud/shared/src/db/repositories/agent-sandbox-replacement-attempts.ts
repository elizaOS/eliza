/**
 * Persists and advances one-shot sandbox replacement attempts on the primary.
 * Every callback is fenced by tenant, agent, activation generation, and the
 * byte-identical S0 locator. Ambiguous effects also hold an agent-wide fence;
 * no API expires, deletes, or reopens an attempt.
 */

import { Buffer } from "node:buffer";
import { ElizaError } from "@elizaos/core";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { isUniqueConstraintError } from "../../lib/utils/db-errors";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import { agentBackupRestoreLeases } from "../schemas/agent-backup-catalog";
import {
  AGENT_SANDBOX_REPLACEMENT_OPERATION_KINDS,
  type AgentSandboxReplacementAttempt,
  type AgentSandboxReplacementOperationKind,
  agentSandboxReplacementAttempts,
} from "../schemas/agent-sandbox-replacement-attempts";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import { dockerNodes } from "../schemas/docker-nodes";
import { organizations } from "../schemas/organizations";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_REPLACEMENT_ATTEMPT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
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

/** Exact authority S2 must re-present when atomically adopting provider success. */
export interface CommitAgentSandboxReplacementLifecycleAdoptionInput
  extends StartAgentSandboxReplacementAttemptInput {
  readonly locator: AgentSandboxReplacementLocatorInput;
  readonly providerReceiptDigest: string;
  readonly lifecycleReceiptDigest: string;
}

export interface AgentSandboxReplacementAttemptWriteResult {
  readonly attempt: Readonly<AgentSandboxReplacementAttempt>;
  readonly replayed: boolean;
}

export interface StartOrReplayExactRestoreReplacementIntentInput
  extends AgentSandboxReplacementAttemptReference {
  readonly lifecycleRevision: string;
  readonly activationGeneration: string;
  readonly lifecycleJobId: string | null;
  readonly lifecycleExecutionGeneration: string | null;
  readonly restoreAuthority: AgentSandboxReplacementRestoreAuthority;
  readonly locator: AgentSandboxReplacementLocatorInput;
  /** Primary-database clock read after the caller acquired every authority lock. */
  readonly databaseNow: Date;
}

/** Caller-locked exact restore boundary immediately before the provider effect. */
export interface MarkAgentSandboxExactRestoreProviderStartedForLockedAuthoritiesInput
  extends StartOrReplayExactRestoreReplacementIntentInput {}

/** Caller-locked exact restore boundary after Docker identity is durably composed. */
export interface RecordAgentSandboxExactRestoreProviderSucceededForLockedAuthoritiesInput
  extends StartOrReplayExactRestoreReplacementIntentInput {
  readonly receiptDigest: string;
}

/** Caller-locked transition that fences every late provider callback before remote cleanup. */
export interface BeginAgentSandboxExactRestoreCleanupForLockedAuthoritiesInput
  extends StartOrReplayExactRestoreReplacementIntentInput {}

/** Caller-locked final cleanup proof; lease expiry cannot strand retained capacity. */
export interface FinishAgentSandboxExactRestoreCleanupForLockedAuthoritiesInput
  extends StartOrReplayExactRestoreReplacementIntentInput {
  readonly receiptDigest: string;
}

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

type LocatorStage = "intent" | "created" | "vpn" | "final" | "cleanup";

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
  const operationKind = record.operationKind as AgentSandboxReplacementOperationKind;
  const activationGeneration = requireCanonicalUuid(
    record.activationGeneration,
    "activationGeneration",
  );
  const restoreAuthority = validateRestoreAuthority(record.restoreAuthority);
  if (
    restoreAuthority !== null &&
    (operationKind !== "provision" || activationGeneration !== restoreAuthority.restoreAttemptId)
  ) {
    throw invalidInput(
      "restoreAuthority requires provision and its restore attempt as activation generation",
      "restoreAuthority",
    );
  }
  return {
    ...reference,
    operationKind,
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

function validateLocator(
  input: unknown,
  reference: ValidatedReference,
  stage: LocatorStage,
  restoreAttemptId: string | null = null,
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
  const expectedContainerName = restoreAttemptId
    ? `agent-restore-${reference.agentId}-${restoreAttemptId}`
    : `agent-${reference.agentId}`;
  if (
    sandboxId !== containerName ||
    containerName !== expectedContainerName ||
    !/^agent-[a-zA-Z0-9_-]+$/.test(containerName)
  ) {
    throw invalidInput(
      "locator sandbox and container names must equal the deterministic replacement container",
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
      : typeof locator.containerId === "string" && CANONICAL_CONTAINER_ID.test(locator.containerId)
        ? locator.containerId
        : (() => {
            throw invalidInput(
              "locator.containerId must be a canonical Docker ID or null",
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
    (stage === "final" && vpnNodeName !== null && vpnNodeId === null) ||
    (stage === "cleanup" &&
      (vpnNodeName !== null ||
        vpnRegistrationStartedAt !== null ||
        previousVpnNodeId !== null ||
        vpnNodeId !== null))
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
  if (isTerminal(attempt) || attempt.state === "cleanup_in_progress") {
    throw conflict(
      "Terminal replacement attempt cannot accept provider callbacks",
      reference,
      attempt.state,
    );
  }
}

function assertOptionalContainerMatches(
  attempt: AgentSandboxReplacementAttempt,
  containerId: string | null,
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
  lifecycleJobId: string | null;
  lifecycleExecutionGeneration: string | null;
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
      lifecycleJobId: agentSandboxes.lifecycle_job_id,
      lifecycleExecutionGeneration: agentSandboxes.lifecycle_execution_generation,
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
): void {
  if (
    sandbox.id !== expected.agentId ||
    sandbox.organizationId !== expected.organizationId ||
    sandbox.lifecycleRevision !== expected.lifecycleRevision.toString() ||
    sandbox.activationGeneration !== expected.activationGeneration ||
    sandbox.lifecycleJobId !== expected.lifecycleJobId ||
    sandbox.lifecycleExecutionGeneration !== expected.lifecycleExecutionGeneration
  ) {
    throw conflict("Agent sandbox lifecycle authority does not match", expected);
  }
}

async function lockAndValidateAgentSandboxAuthority(
  tx: DbTransaction,
  expected: ValidatedStart,
): Promise<void> {
  assertAgentSandboxAuthorityMatches(await lockAgentSandboxAuthority(tx, expected), expected);
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

async function lockAndValidateReplacementNodeAuthority(
  tx: DbTransaction,
  locator: ValidatedLocator,
  reference: ValidatedReference,
): Promise<void> {
  const [node] = await tx
    .select({ id: dockerNodes.id })
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
        gt(dockerNodes.allocated_count, 0),
      ),
    )
    .for("no key update")
    .limit(1);
  if (!node) {
    throw conflict("Replacement Docker-node authority does not match", reference);
  }
}

/**
 * Insert the pre-effect one-shot marker. Any existing ID is rejected even when
 * its bytes match: replaying start could launch provider effects a second time.
 * The caller owns the transaction so its lifecycle admission CAS and this row
 * either commit or roll back together. This function owns the complete lock
 * order: organization (KEY SHARE), restore lease when present (UPDATE), sandbox
 * (UPDATE), then attempt insert. A caller must not pre-lock the sandbox before
 * entering this function or it can reintroduce an account-deletion deadlock.
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
    let restoreLeaseExpiresAt: Date | null = null;
    if (restore) {
      // Restore operations globally lock lease authority before the sandbox.
      // Preserve that order here so start cannot form an AB-BA deadlock.
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
      if (lease.released_at !== null) {
        throw conflict("Restore lease is expired or released", validated);
      }
      restoreLeaseExpiresAt = new Date(lease.expires_at.getTime());
      await assertRestoreLeaseNotExpired(tx, restoreLeaseExpiresAt, validated);
    }
    await lockAndValidateAgentSandboxAuthority(tx, validated);
    if (restoreLeaseExpiresAt) {
      // The lease row remains UPDATE-locked, so it cannot be released, but its
      // wall-clock expiry can pass while the sandbox lock is contended.
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

/**
 * Insert or exactly replay the pre-effect restore attempt and its complete S0
 * locator. The caller owns the transaction and must already hold organization,
 * backup, restore-operation, lease, sandbox, node-occurrence, and catalogue
 * authority in that order. Keeping this helper lock-free is what lets the
 * combined restore writer commit quarantine, capacity, and this fence together.
 *
 * Unlike the legacy start API, exact replay is intentional here: the caller has
 * not crossed the provider boundary yet, and a lost database response must not
 * allocate another slot or mint another locator. A cleanup-proven attempt stays
 * one-shot and cannot be reopened.
 */
export async function startOrReplayExactRestoreReplacementIntentInTransaction(
  tx: DbTransaction,
  input: StartOrReplayExactRestoreReplacementIntentInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  if (!(input.databaseNow instanceof Date) || !Number.isFinite(input.databaseNow.getTime())) {
    throw invalidInput("databaseNow must be a valid primary-database Date", "databaseNow");
  }
  const validated = validateStart({
    attemptId: input.attemptId,
    organizationId: input.organizationId,
    agentId: input.agentId,
    operationKind: "provision",
    lifecycleRevision: input.lifecycleRevision,
    activationGeneration: input.activationGeneration,
    lifecycleJobId: input.lifecycleJobId,
    lifecycleExecutionGeneration: input.lifecycleExecutionGeneration,
    restoreAuthority: input.restoreAuthority,
  });
  const restore = validated.restoreAuthority;
  if (!restore || validated.activationGeneration !== restore.restoreAttemptId) {
    throw conflict(
      "Exact restore replacement must use its restore attempt as activation generation",
      validated,
    );
  }
  const locator = validateLocator(input.locator, validated, "intent", restore.restoreAttemptId);
  if (restore.expiresAt <= input.databaseNow) {
    throw conflict("Restore lease is expired or released", validated);
  }

  try {
    const [existing] = await tx
      .select()
      .from(agentSandboxReplacementAttempts)
      .where(
        and(
          eq(agentSandboxReplacementAttempts.id, validated.attemptId),
          eq(agentSandboxReplacementAttempts.organization_id, validated.organizationId),
          eq(agentSandboxReplacementAttempts.agent_id, validated.agentId),
        ),
      )
      .for("update")
      .limit(1);
    if (existing) {
      assertStartAuthorityMatches(existing, validated);
      assertLocatorCoreMatches(existing, locator, validated);
      if (existing.state === "cleanup_proven") {
        throw conflict(
          "Cleanup-proven replacement attempt cannot be reused for another provider effect",
          validated,
          existing.state,
        );
      }
      if (existing.state === "lifecycle_committed") {
        throw conflict(
          "Lifecycle-committed replacement attempt cannot restart provider work",
          validated,
          existing.state,
        );
      }
      return frozenResult(existing, true);
    }

    const [created] = await tx
      .insert(agentSandboxReplacementAttempts)
      .values({
        id: validated.attemptId,
        organization_id: validated.organizationId,
        agent_id: validated.agentId,
        operation_kind: "provision",
        lifecycle_revision: validated.lifecycleRevision,
        activation_generation: validated.activationGeneration,
        lifecycle_job_id: validated.lifecycleJobId,
        lifecycle_execution_generation: validated.lifecycleExecutionGeneration,
        restore_lease_id: restore.leaseId,
        restore_backup_id: restore.backupId,
        restore_attempt_id: restore.restoreAttemptId,
        restore_lease_owner_id: restore.ownerId,
        restore_lease_generation: restore.fencingToken,
        restore_catalog_epoch: restore.catalogEpoch,
        restore_copy_role: restore.copyRole,
        restore_operation_id: restore.operationId,
        restore_source_activation_generation: restore.sourceActivationGeneration,
        restore_source_lifecycle_revision: restore.sourceLifecycleRevision,
        restore_manifest_sha256: restore.expectedManifestSha256,
        restore_lease_expires_at: restore.expiresAt,
        created_at: input.databaseNow,
        updated_at: input.databaseNow,
      })
      .returning({ id: agentSandboxReplacementAttempts.id });
    if (!created) {
      throw conflict("Exact restore replacement intent insert returned no row", validated);
    }

    // The admission trigger intentionally requires an empty start row. Bind
    // the complete S0 locator in the immediately following statement; the
    // caller's transaction still makes start + locator one atomic intent.
    const [recorded] = await tx
      .update(agentSandboxReplacementAttempts)
      .set({
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
        locator_vpn_node_name: null,
        locator_vpn_registration_started_at: null,
        locator_previous_vpn_node_id: null,
        locator_recorded_at: input.databaseNow,
        updated_at: input.databaseNow,
      })
      .where(
        and(
          eq(agentSandboxReplacementAttempts.id, validated.attemptId),
          eq(agentSandboxReplacementAttempts.organization_id, validated.organizationId),
          eq(agentSandboxReplacementAttempts.agent_id, validated.agentId),
          eq(agentSandboxReplacementAttempts.state, "in_flight_unresolved"),
          isNull(agentSandboxReplacementAttempts.locator_recorded_at),
        ),
      )
      .returning();
    if (!recorded) {
      throw conflict("Exact restore replacement locator write lost its CAS", validated);
    }
    return frozenResult(recorded, false);
  } catch (error) {
    if (error instanceof ElizaError) throw error;
    if (isUniqueConstraintError(error)) {
      throw conflict(
        "Exact restore replacement ID, agent-wide effect, or activation generation is already owned",
        validated,
      );
    }
    throw error;
  }
}

async function recordLocatorStageInTransaction(
  tx: DbTransaction,
  referenceInput: AgentSandboxReplacementAttemptReference,
  locatorInput: AgentSandboxReplacementLocatorInput,
  stage: "intent" | "created" | "vpn",
  exactRestorePolicy: "allow" | "reject" = "allow",
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  const reference = validateReference(referenceInput);
  const current = await lockAttempt(tx, reference);
  if (exactRestorePolicy === "reject" && current.restore_attempt_id !== null) {
    throw conflict(
      "Exact restore provider callbacks require the locked restore settlement boundary",
      reference,
      current.state,
    );
  }
  const locator = validateLocator(locatorInput, reference, stage, current.restore_attempt_id);
  assertCallbackStageOpen(current, reference);
  if (
    stage === "created" &&
    current.restore_attempt_id !== null &&
    current.provider_started_at === null
  ) {
    throw conflict(
      "Exact restore Docker enrichment requires its durable provider-start marker",
      reference,
      current.state,
    );
  }
  const databaseNow = await readPostLockDatabaseNow(tx);

  if (stage === "intent") {
    if (hasLocator(current)) {
      assertLocatorCoreMatches(current, locator, reference);
      return frozenResult(current, true);
    }
    const [recorded] = await tx
      .update(agentSandboxReplacementAttempts)
      .set({
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
      throw conflict("Replacement intent lost its state CAS", reference, current.state);
    }
    return frozenResult(recorded, false);
  }

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
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  return await recordLocatorStageInTransaction(tx, reference, locator, "intent");
}

/**
 * Prove that an exact-restore S0 callback is a byte-identical replay. Unlike
 * the legacy intent recorder this verifier never fills an absent locator, so a
 * provider callback cannot become the authority that chooses placement.
 */
export async function verifyAgentSandboxExactRestoreReplacementIntent(
  referenceInput: AgentSandboxReplacementAttemptReference,
  locatorInput: AgentSandboxReplacementLocatorInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  const reference = validateReference(referenceInput);
  return await dbWrite.transaction(async (tx) => {
    const current = await lockAttempt(tx, reference);
    if (current.restore_attempt_id === null) {
      throw conflict("Exact restore intent verifier requires restore authority", reference);
    }
    const locator = validateLocator(locatorInput, reference, "intent", current.restore_attempt_id);
    assertCallbackStageOpen(current, reference);
    if (!hasLocator(current)) {
      throw conflict(
        "Exact restore intent verifier cannot create missing S0 authority",
        reference,
        current.state,
      );
    }
    assertLocatorCoreMatches(current, locator, reference);
    return frozenResult(current, true);
  });
}

function validateLockedExactRestoreProviderBoundary(
  input: StartOrReplayExactRestoreReplacementIntentInput,
  stage: "intent" | "final" | "cleanup",
  requireLiveRestoreAuthority = true,
): {
  expected: ValidatedStart & { restoreAuthority: ValidatedRestoreAuthority };
  locator: ValidatedLocator;
} {
  if (!(input.databaseNow instanceof Date) || !Number.isFinite(input.databaseNow.getTime())) {
    throw invalidInput("databaseNow must be a valid primary-database Date", "databaseNow");
  }
  const expected = validateStart({
    attemptId: input.attemptId,
    organizationId: input.organizationId,
    agentId: input.agentId,
    operationKind: "provision",
    lifecycleRevision: input.lifecycleRevision,
    activationGeneration: input.activationGeneration,
    lifecycleJobId: input.lifecycleJobId,
    lifecycleExecutionGeneration: input.lifecycleExecutionGeneration,
    restoreAuthority: input.restoreAuthority,
  });
  const restore = expected.restoreAuthority;
  if (!restore || expected.activationGeneration !== restore.restoreAttemptId) {
    throw conflict("Exact restore provider boundary requires restore authority", expected);
  }
  if (requireLiveRestoreAuthority && restore.expiresAt <= input.databaseNow) {
    throw conflict("Restore lease is expired or released", expected);
  }
  return {
    expected: { ...expected, restoreAuthority: restore },
    locator: validateLocator(input.locator, expected, stage, restore.restoreAttemptId),
  };
}

/**
 * Write the immutable one-shot provider-start marker after the caller has
 * locked and re-proved the restore operation, lease, sandbox, target occurrence,
 * and catalogue. A replay proves the same S0 bytes but can never authorize a
 * second remote call.
 */
export async function markAgentSandboxExactRestoreProviderStartedForLockedAuthoritiesInTransaction(
  tx: DbTransaction,
  input: MarkAgentSandboxExactRestoreProviderStartedForLockedAuthoritiesInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  const { expected, locator } = validateLockedExactRestoreProviderBoundary(input, "intent");
  const current = await lockAttempt(tx, expected);
  assertStartAuthorityMatches(current, expected);
  assertLocatorCoreMatches(current, locator, expected);
  if (current.state !== "in_flight_unresolved" || current.locator_container_id !== null) {
    throw conflict(
      "Exact restore provider start requires an unresolved pre-create intent",
      expected,
      current.state,
    );
  }
  if (current.provider_started_at !== null) {
    return frozenResult(current, true);
  }

  const [recorded] = await tx
    .update(agentSandboxReplacementAttempts)
    .set({ provider_started_at: input.databaseNow, updated_at: input.databaseNow })
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, expected.attemptId),
        eq(agentSandboxReplacementAttempts.organization_id, expected.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, expected.agentId),
        eq(agentSandboxReplacementAttempts.state, "in_flight_unresolved"),
        isNotNull(agentSandboxReplacementAttempts.locator_recorded_at),
        isNull(agentSandboxReplacementAttempts.locator_container_id),
        isNull(agentSandboxReplacementAttempts.provider_started_at),
      ),
    )
    .returning();
  if (!recorded) {
    throw conflict("Exact restore provider-start marker lost its CAS", expected, current.state);
  }
  return frozenResult(recorded, false);
}

/**
 * Settle provider success only after a caller-locked restore operation and its
 * exact node/SSH locator have been re-proved. The receipt digest is immutable,
 * and response-loss replay never rewrites the settlement timestamp.
 */
export async function recordAgentSandboxExactRestoreProviderSucceededForLockedAuthoritiesInTransaction(
  tx: DbTransaction,
  input: RecordAgentSandboxExactRestoreProviderSucceededForLockedAuthoritiesInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  // A provider-success response may be lost just before the lease expires. The
  // already-settled immutable receipt remains replayable, but lease expiry must
  // still fence the first transition into provider_succeeded.
  const { expected, locator } = validateLockedExactRestoreProviderBoundary(input, "final", false);
  const receiptDigest = requireSha256(input.receiptDigest, "receiptDigest");
  const current = await lockAttempt(tx, expected);
  assertStartAuthorityMatches(current, expected);
  assertLocatorCoreMatches(current, locator, expected);
  assertContainerMatches(current, locator.containerId!, expected);
  assertVpnMatches(current, locator.vpnNodeId, expected);
  if (current.provider_started_at === null) {
    throw conflict(
      "Exact restore provider success requires its durable start marker",
      expected,
      current.state,
    );
  }
  if (current.state === "provider_succeeded" || current.state === "lifecycle_committed") {
    if (current.provider_receipt_digest !== receiptDigest) {
      throw conflict("Provider-success receipt replay mismatch", expected, current.state);
    }
    return frozenResult(current, true);
  }
  if (expected.restoreAuthority.expiresAt <= input.databaseNow) {
    throw conflict("Restore lease is expired or released", expected, current.state);
  }
  if (current.state !== "in_flight_unresolved") {
    throw conflict("Provider success cannot advance a terminal attempt", expected, current.state);
  }

  const [recorded] = await tx
    .update(agentSandboxReplacementAttempts)
    .set({
      state: "provider_succeeded",
      provider_succeeded_at: input.databaseNow,
      provider_receipt_digest: receiptDigest,
      updated_at: input.databaseNow,
    })
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, expected.attemptId),
        eq(agentSandboxReplacementAttempts.organization_id, expected.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, expected.agentId),
        eq(agentSandboxReplacementAttempts.state, "in_flight_unresolved"),
        isNotNull(agentSandboxReplacementAttempts.provider_started_at),
      ),
    )
    .returning();
  if (!recorded) {
    throw conflict(
      "Exact restore provider-success settlement lost its CAS",
      expected,
      current.state,
    );
  }
  return frozenResult(recorded, false);
}

/**
 * Commit a durable cleanup fence before any remote tombstone or removal. Once
 * this CAS wins, both Docker enrichment and provider-success settlement reject,
 * so a delayed callback cannot resurrect a remotely removed candidate.
 */
export async function beginAgentSandboxExactRestoreCleanupForLockedAuthoritiesInTransaction(
  tx: DbTransaction,
  input: BeginAgentSandboxExactRestoreCleanupForLockedAuthoritiesInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  const { expected, locator } = validateLockedExactRestoreProviderBoundary(input, "cleanup", false);
  const current = await lockAttempt(tx, expected);
  assertStartAuthorityMatches(current, expected);
  assertLocatorCoreMatches(current, locator, expected);
  assertOptionalContainerMatches(current, locator.containerId, expected);
  if (current.state === "cleanup_in_progress" || current.state === "cleanup_proven") {
    return frozenResult(current, true);
  }
  if (current.state !== "in_flight_unresolved" && current.state !== "provider_succeeded") {
    throw conflict(
      "Exact restore cleanup requires an unresolved or unadopted provider effect",
      expected,
      current.state,
    );
  }

  const [recorded] = await tx
    .update(agentSandboxReplacementAttempts)
    .set({ state: "cleanup_in_progress", updated_at: input.databaseNow })
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, expected.attemptId),
        eq(agentSandboxReplacementAttempts.organization_id, expected.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, expected.agentId),
        eq(agentSandboxReplacementAttempts.state, current.state),
      ),
    )
    .returning();
  if (!recorded) {
    throw conflict("Exact restore cleanup-begin lost its state CAS", expected, current.state);
  }
  return frozenResult(recorded, false);
}

/** Finalize a previously fenced exact cleanup after the provider returned proof. */
export async function finishAgentSandboxExactRestoreCleanupForLockedAuthoritiesInTransaction(
  tx: DbTransaction,
  input: FinishAgentSandboxExactRestoreCleanupForLockedAuthoritiesInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  const { expected, locator } = validateLockedExactRestoreProviderBoundary(input, "cleanup", false);
  const receiptDigest = requireSha256(input.receiptDigest, "receiptDigest");
  const current = await lockAttempt(tx, expected);
  assertStartAuthorityMatches(current, expected);
  assertLocatorCoreMatches(current, locator, expected);
  assertOptionalContainerMatches(current, locator.containerId, expected);
  if (current.state === "cleanup_proven") {
    if (current.cleanup_receipt_digest !== receiptDigest) {
      throw conflict("Cleanup receipt replay mismatch", expected, current.state);
    }
    return frozenResult(current, true);
  }
  if (current.state !== "cleanup_in_progress") {
    throw conflict(
      "Exact restore cleanup proof requires its durable cleanup-begin fence",
      expected,
      current.state,
    );
  }

  const [recorded] = await tx
    .update(agentSandboxReplacementAttempts)
    .set({
      state: "cleanup_proven",
      cleanup_proven_at: input.databaseNow,
      cleanup_receipt_digest: receiptDigest,
      updated_at: input.databaseNow,
    })
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, expected.attemptId),
        eq(agentSandboxReplacementAttempts.organization_id, expected.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, expected.agentId),
        eq(agentSandboxReplacementAttempts.state, "cleanup_in_progress"),
      ),
    )
    .returning();
  if (!recorded) {
    throw conflict("Exact restore cleanup settlement lost its state CAS", expected, current.state);
  }
  return frozenResult(recorded, false);
}

/** Enrich Docker identity inside a caller-owned restore/quarantine transaction. */
export async function recordAgentSandboxReplacementCreatedInTransaction(
  tx: DbTransaction,
  reference: AgentSandboxReplacementAttemptReference,
  locator: AgentSandboxReplacementLocatorInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  return await recordLocatorStageInTransaction(tx, reference, locator, "created");
}

/** Legacy provider callback; exact restore must use its fully locked boundary. */
export async function recordAgentSandboxReplacementCreated(
  reference: AgentSandboxReplacementAttemptReference,
  locator: AgentSandboxReplacementLocatorInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  return await dbWrite.transaction((tx) =>
    recordLocatorStageInTransaction(tx, reference, locator, "created", "reject"),
  );
}

/** Legacy VPN callback; exact restore never admits this unlocked wrapper. */
export async function recordAgentSandboxReplacementVpnRegistered(
  reference: AgentSandboxReplacementAttemptReference,
  locator: AgentSandboxReplacementLocatorInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  return await dbWrite.transaction((tx) =>
    recordLocatorStageInTransaction(tx, reference, locator, "vpn", "reject"),
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
  const receiptDigest = requireSha256(receiptDigestInput, "receiptDigest");
  return await dbWrite.transaction(async (tx) => {
    const current = await lockAttempt(tx, reference);
    if (current.restore_attempt_id !== null) {
      throw conflict(
        "Exact restore provider callbacks require the locked restore settlement boundary",
        reference,
        current.state,
      );
    }
    const locator = validateLocator(locatorInput, reference, "final", current.restore_attempt_id);
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
 * Consume exact provider success inside S2's lifecycle transaction. This helper
 * never starts or commits a transaction; a later caller failure rolls its CAS
 * back and keeps `provider_succeeded` visibly active.
 */
export async function commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
  tx: DbTransaction,
  input: CommitAgentSandboxReplacementLifecycleAdoptionInput,
): Promise<AgentSandboxReplacementAttemptWriteResult> {
  const expected = validateStart(input);
  const locator = validateLocator(
    input.locator,
    expected,
    "final",
    expected.restoreAuthority?.restoreAttemptId ?? null,
  );
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
  assertLocatorCoreMatches(current, locator, expected);
  assertContainerMatches(current, locator.containerId!, expected);
  assertVpnMatches(current, locator.vpnNodeId, expected);
  if (current.provider_receipt_digest !== providerReceiptDigest) {
    throw conflict("Provider receipt does not match lifecycle adoption", expected, current.state);
  }
  if (current.state === "lifecycle_committed") {
    if (current.lifecycle_receipt_digest !== lifecycleReceiptDigest) {
      throw conflict("Lifecycle receipt replay mismatch", expected, current.state);
    }
    return frozenResult(current, true);
  }
  if (current.state !== "provider_succeeded") {
    throw conflict("Lifecycle commit requires provider success", expected, current.state);
  }
  assertAgentSandboxAuthorityMatches(sandbox, expected);
  await lockAndValidateReplacementNodeAuthority(tx, locator, expected);
  const databaseNow = await readPostLockDatabaseNow(tx);
  const [recorded] = await tx
    .update(agentSandboxReplacementAttempts)
    .set({
      state: "lifecycle_committed",
      lifecycle_committed_at: databaseNow,
      lifecycle_receipt_digest: lifecycleReceiptDigest,
      updated_at: databaseNow,
    })
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, expected.attemptId),
        eq(agentSandboxReplacementAttempts.organization_id, expected.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, expected.agentId),
        eq(agentSandboxReplacementAttempts.state, "provider_succeeded"),
      ),
    )
    .returning();
  if (!recorded) {
    throw conflict("Lifecycle commit lost its state CAS", expected, current.state);
  }
  return frozenResult(recorded, false);
}

/**
 * Terminally retain exact cleanup proof. It may close an unresolved call or a
 * provider-success candidate rejected before lifecycle adoption. The caller
 * owns the transaction that clears the exact locator and releases capacity.
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
  if (current.restore_attempt_id !== null) {
    throw conflict(
      "Exact restore cleanup must use its claim-fenced settlement boundary",
      reference,
      current.state,
    );
  }
  if (current.state === "cleanup_proven") {
    if (current.cleanup_receipt_digest !== receiptDigest) {
      throw conflict("Cleanup receipt replay mismatch", reference, current.state);
    }
    return frozenResult(current, true);
  }
  if (
    current.state !== "in_flight_unresolved" &&
    current.state !== "provider_succeeded" &&
    current.state !== "cleanup_in_progress"
  ) {
    throw conflict("Cleanup proof cannot replace lifecycle commitment", reference, current.state);
  }
  const databaseNow = await readPostLockDatabaseNow(tx);
  const [recorded] = await tx
    .update(agentSandboxReplacementAttempts)
    .set({
      state: "cleanup_proven",
      cleanup_proven_at: databaseNow,
      cleanup_receipt_digest: receiptDigest,
      updated_at: databaseNow,
    })
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, reference.attemptId),
        eq(agentSandboxReplacementAttempts.organization_id, reference.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, reference.agentId),
        eq(agentSandboxReplacementAttempts.state, current.state),
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
