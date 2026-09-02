/**
 * Durable phase store for one restore attempt.
 *
 * Each phase records the identity of the side effect it completed, so a worker
 * that loses its response can later compare rather than repeat. The readers that
 * do that comparison arrive with the phases themselves; this slice is the spine
 * they hang from, and nothing here creates containers or contacts an agent.
 *
 * The fencing token is the lease's own `generation`: a second token would let an
 * operation outlive the authority it rests on.
 */

import { Buffer } from "node:buffer";
import { and, eq, gt, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { requireBoundedIdentity } from "../../lib/services/agent-backup-catalog-state";
import { isValidUUID } from "../../lib/utils/validation";
import { dbWrite } from "../helpers";
import {
  type AgentBackupRestoreOperation,
  type AgentBackupRestorePhase,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "../schemas/agent-backup-catalog";
import {
  type AgentSandboxReplacementAttempt,
  agentSandboxReplacementAttempts,
} from "../schemas/agent-sandbox-replacement-attempts";
import {
  type AgentExecutionTier,
  type AgentSandbox,
  agentSandboxBackups,
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
} from "../schemas/agent-sandboxes";
import { dockerNodes, PLACEABLE_NODE_STATE } from "../schemas/docker-nodes";
import { organizations } from "../schemas/organizations";
import {
  AgentBackupCatalogConflictError,
  lockAgentBackupCatalogAuthority,
} from "./agent-backup-catalog";
import { parseAgentBackupManifestV3Authority } from "./agent-backup-restore";
import { hasAgentBackupRestoreAuthority } from "./agent-backup-restore-authority";
import { proveExactAgentNodeOccurrenceForLockedNode } from "./agent-backup-restore-history";
import type { AgentBackupRestoreLeaseAuthorityReceipt } from "./agent-backup-restore-lease";
import {
  openAgentBackupRestoreQuarantineForLockedAuthoritiesInTransaction,
  rearmAgentBackupRestoreQuarantineAfterExactProviderCleanupForLockedAuthoritiesInTransaction,
  recordAgentBackupRestoreQuarantinedContainerForLockedAuthoritiesInTransaction,
  verifyAgentBackupRestoreQuarantineForLockedAuthorities,
} from "./agent-backup-restore-quarantine";
import {
  type AgentSandboxReplacementLocatorInput,
  beginAgentSandboxExactRestoreCleanupForLockedAuthoritiesInTransaction,
  finishAgentSandboxExactRestoreCleanupForLockedAuthoritiesInTransaction,
  markAgentSandboxExactRestoreProviderStartedForLockedAuthoritiesInTransaction,
  recordAgentSandboxExactRestoreProviderSucceededForLockedAuthoritiesInTransaction,
  recordAgentSandboxReplacementCreatedInTransaction,
  startOrReplayExactRestoreReplacementIntentInTransaction,
} from "./agent-sandbox-replacement-attempts";
import { readPostLockDatabaseNow } from "./primary-database-clock";

/** Terminal phases: no claim may advance out of them. */
const TERMINAL_PHASES = ["finalized", "failed_terminal"] as const;

/** Phase order; a claim may only move forward through it. */
const PHASE_ORDER: readonly AgentBackupRestorePhase[] = [
  "reserved",
  "vault_seeded",
  "container_created",
  "restoring",
  "committed",
  "restart_attested",
  "probed",
  "published",
  "finalized",
];
const CONTAINER_CREATED_PHASE_RANK = PHASE_ORDER.indexOf("container_created");

const MIN_CLAIM_MS = 1_000;
const MAX_CLAIM_MS = 3_600_000;
const MAX_RETRY_DELAY_MS = 3_600_000;
const MAX_ACTIVATION_TOKEN_CIPHERTEXT_BYTES = 16_384;
const SHA256_IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GHCR_REPOSITORY_SEGMENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export type AgentBackupRestoreExactImagePlatform = "linux/amd64" | "linux/arm64";

export interface OpenAgentBackupRestoreOperationInput {
  authority: AgentBackupRestoreLeaseAuthorityReceipt;
  leaseId: string;
}

export interface AgentBackupRestoreOperationClaim {
  operation: Readonly<AgentBackupRestoreOperation>;
  claimGeneration: string;
  databaseNow: Date;
}

interface AgentSandboxExactRestoreCleanupClaimBase {
  readonly operation: Readonly<AgentBackupRestoreOperation>;
  readonly attempt: Readonly<AgentSandboxReplacementAttempt>;
  readonly locator: Readonly<AgentSandboxReplacementLocatorInput>;
  readonly databaseNow: Date;
}

export type AgentSandboxExactRestoreCleanupClaim =
  | (AgentSandboxExactRestoreCleanupClaimBase & {
      readonly status: "claimed";
      readonly claimGeneration: string;
    })
  | (AgentSandboxExactRestoreCleanupClaimBase & {
      readonly status: "cleanup_proven";
      readonly claimGeneration: null;
    });

export interface AgentBackupRestoreTargetAuthority {
  nodeRecordId: string;
  nodeId: string;
  nodeIncarnation: string;
  nodeHistoryId: string;
  imageDigest: string;
  platform: AgentBackupRestoreExactImagePlatform;
  imageReference: string | null;
  imagePlatformDigest: string | null;
}

export interface ReserveAgentBackupRestoreTargetResult {
  operation: Readonly<AgentBackupRestoreOperation>;
  target: Readonly<AgentBackupRestoreTargetAuthority>;
  replayed: boolean;
}

export interface RecordAgentBackupRestoreExactImagePlatformAuthorityInput {
  readonly operationId: string;
  readonly ownerId: string;
  readonly claimGeneration: string;
  readonly imageReference: string;
  readonly imagePlatformDigest: string;
}

export interface RecordAgentBackupRestoreExactImagePlatformAuthorityResult {
  readonly operation: Readonly<AgentBackupRestoreOperation>;
  readonly target: Readonly<
    Omit<AgentBackupRestoreTargetAuthority, "imageReference" | "imagePlatformDigest"> & {
      imageReference: string;
      imagePlatformDigest: string;
    }
  >;
  readonly replayed: boolean;
}

export interface ReserveAgentBackupRestoreTargetAndStartReplacementIntentInput {
  operationId: string;
  ownerId: string;
  claimGeneration: string;
  targetNodeRecordId: string;
  targetNodeId: string;
  targetNodeIncarnation: string;
  targetNodeHistoryId: string;
  replacementAttemptId: string;
  activationTokenSha256: string;
  activationTokenCiphertext: string;
}

export interface AgentBackupRestoreSandboxCreateAuthority {
  readonly agentId: string;
  readonly agentName: string;
  readonly organizationId: string;
  readonly executionTier: AgentExecutionTier;
  readonly environmentVars: Readonly<Record<string, string>>;
  readonly agentConfig: Readonly<Record<string, unknown>> | null;
  readonly routeAgentId: string | null;
  readonly dockerImageReference: string;
  readonly activationTokenSha256: string;
  readonly activationTokenCiphertext: string;
  readonly activationGeneration: string;
  readonly lifecycleRevision: string;
}

export interface ReserveAgentBackupRestoreTargetAndStartReplacementIntentResult {
  readonly operation: Readonly<AgentBackupRestoreOperation>;
  readonly target: Readonly<AgentBackupRestoreTargetAuthority>;
  readonly sandbox: Readonly<AgentBackupRestoreSandboxCreateAuthority>;
  readonly attempt: Readonly<AgentSandboxReplacementAttempt>;
  readonly locator: Readonly<AgentSandboxReplacementLocatorInput>;
  readonly replayed: Readonly<{
    target: boolean;
    quarantine: boolean;
    replacementIntent: boolean;
  }>;
}

export interface AgentSandboxExactRestoreProviderBoundaryInput {
  readonly operationId: string;
  readonly ownerId: string;
  readonly claimGeneration: string;
  readonly replacementAttemptId: string;
  readonly locator: AgentSandboxReplacementLocatorInput;
}

export interface RecordAgentSandboxExactRestoreProviderSucceededInput
  extends AgentSandboxExactRestoreProviderBoundaryInput {
  readonly receiptDigest: string;
}

export interface BeginAgentSandboxExactRestoreCleanupInput {
  readonly operationId: string;
  readonly ownerId: string;
  readonly claimGeneration: string;
  readonly replacementAttemptId: string;
}

export interface FinishAgentSandboxExactRestoreCleanupInput {
  readonly operationId: string;
  readonly ownerId: string;
  readonly claimGeneration: string;
  readonly replacementAttemptId: string;
  readonly locator: AgentSandboxReplacementLocatorInput;
  readonly cleanupReceiptDigest: string;
}

export interface AgentSandboxExactRestoreProviderBoundaryResult {
  readonly operation: Readonly<AgentBackupRestoreOperation>;
  readonly attempt: Readonly<AgentSandboxReplacementAttempt>;
  readonly locator: Readonly<AgentSandboxReplacementLocatorInput>;
  readonly replayed: boolean;
}

function requireOwnerId(value: string): string {
  requireBoundedIdentity(value, "ownerId");
  if (Buffer.byteLength(value, "utf8") > 255) {
    throw new AgentBackupCatalogConflictError("ownerId must contain at most 255 UTF-8 bytes");
  }
  return value;
}

function requireTargetNodeId(value: string): string {
  requireBoundedIdentity(value, "targetNodeId");
  if (Buffer.byteLength(value, "utf8") > 255) {
    throw new AgentBackupCatalogConflictError("targetNodeId must contain at most 255 UTF-8 bytes");
  }
  return value;
}

function requireActivationTokenCiphertext(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > MAX_ACTIVATION_TOKEN_CIPHERTEXT_BYTES || value.includes("\0")) {
    throw new AgentBackupCatalogConflictError(
      `activationTokenCiphertext must contain between 1 and ${MAX_ACTIVATION_TOKEN_CIPHERTEXT_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

function requireNodeExactImagePlatform(
  metadata: Readonly<Record<string, unknown>>,
): AgentBackupRestoreExactImagePlatform {
  if (metadata.architecture === "amd64") return "linux/amd64";
  if (metadata.architecture === "arm64") return "linux/arm64";
  throw new AgentBackupCatalogConflictError(
    "Restore target requires explicit amd64 or arm64 node architecture authority",
  );
}

function requireImageDigest(value: string, field: string): string {
  if (typeof value !== "string" || !SHA256_IMAGE_DIGEST.test(value)) {
    throw new AgentBackupCatalogConflictError(
      `${field} must be a canonical lowercase sha256 image digest`,
    );
  }
  return value;
}

function requireExactGhcrImageReference(value: string, parentDigest: string): string {
  requireImageDigest(parentDigest, "expectedImageDigest");
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 335 ||
    value !== value.trim() ||
    /\s/.test(value) ||
    !value.startsWith("ghcr.io/") ||
    !value.endsWith(`@${parentDigest}`)
  ) {
    throw new AgentBackupCatalogConflictError(
      "imageReference must be the canonical GHCR reference for the reserved parent digest",
    );
  }
  const suffix = `@${parentDigest}`;
  const repository = value.slice("ghcr.io/".length, -suffix.length);
  const segments = repository.split("/");
  if (
    repository.length > 255 ||
    segments.length < 2 ||
    segments.some((segment) => !GHCR_REPOSITORY_SEGMENT.test(segment))
  ) {
    throw new AgentBackupCatalogConflictError(
      "imageReference must contain a canonical lowercase GHCR repository",
    );
  }
  return value;
}

function immutableOperationAuthorityMatches(
  operation: AgentBackupRestoreOperation,
  authority: AgentBackupRestoreOperation,
): boolean {
  return (
    operation.organization_id === authority.organization_id &&
    operation.agent_id === authority.agent_id &&
    operation.backup_id === authority.backup_id &&
    operation.restore_attempt_id === authority.restore_attempt_id &&
    operation.lease_id === authority.lease_id &&
    operation.lease_generation === authority.lease_generation &&
    operation.lease_owner_id === authority.lease_owner_id &&
    operation.catalog_epoch === authority.catalog_epoch &&
    operation.copy_role === authority.copy_role &&
    operation.expected_operation_id === authority.expected_operation_id &&
    operation.expected_manifest_sha256 === authority.expected_manifest_sha256 &&
    operation.expected_activation_generation === authority.expected_activation_generation &&
    operation.expected_lifecycle_revision === authority.expected_lifecycle_revision
  );
}

function exactRestoreContainerName(agentId: string, restoreAttemptId: string): string {
  const name = `agent-restore-${agentId}-${restoreAttemptId}`;
  if (Buffer.byteLength(name, "utf8") > 128) {
    throw new AgentBackupCatalogConflictError(
      "Exact restore container name exceeds the replacement locator bound",
    );
  }
  return name;
}

function exactRestoreLocatorFromAttempt(
  attempt: AgentSandboxReplacementAttempt,
): Readonly<AgentSandboxReplacementLocatorInput> {
  if (
    attempt.locator_sandbox_id === null ||
    attempt.locator_node_id === null ||
    attempt.locator_container_name === null ||
    attempt.locator_node_record_id === null ||
    attempt.locator_node_incarnation === null ||
    attempt.locator_node_history_id === null ||
    attempt.locator_node_hostname === null ||
    attempt.locator_node_ssh_port === null ||
    attempt.locator_node_ssh_user === null ||
    attempt.locator_node_host_key_fingerprint === null ||
    attempt.locator_secret_cleanup_version !== 1 ||
    attempt.locator_allocation_counted !== true ||
    attempt.locator_vpn_node_name !== null ||
    attempt.locator_vpn_registration_started_at !== null ||
    attempt.locator_previous_vpn_node_id !== null ||
    attempt.locator_vpn_node_id !== null
  ) {
    throw new AgentBackupCatalogConflictError(
      "Exact restore replacement attempt lacks its immutable cleanup locator",
    );
  }
  return Object.freeze({
    replacementAttemptId: attempt.id,
    sandboxId: attempt.locator_sandbox_id,
    nodeId: attempt.locator_node_id,
    containerName: attempt.locator_container_name,
    nodeRecordId: attempt.locator_node_record_id,
    nodeIncarnation: attempt.locator_node_incarnation,
    nodeHistoryId: attempt.locator_node_history_id,
    nodeHostname: attempt.locator_node_hostname,
    nodeSshPort: attempt.locator_node_ssh_port,
    nodeSshUser: attempt.locator_node_ssh_user,
    nodeHostKeyFingerprint: attempt.locator_node_host_key_fingerprint,
    replacementSecretCleanupVersion: 1,
    allocationCounted: true,
    vpnNodeName: null,
    vpnRegistrationStartedAt: null,
    previousVpnNodeId: null,
    containerId: attempt.locator_container_id,
    vpnNodeId: null,
  });
}

function exactRestoreCleanupRetainsProviderSuccess(
  attempt: Readonly<AgentSandboxReplacementAttempt>,
): boolean {
  const hasProviderTimestamp = attempt.provider_succeeded_at !== null;
  const hasProviderReceipt = attempt.provider_receipt_digest !== null;
  if (hasProviderTimestamp !== hasProviderReceipt) {
    throw new AgentBackupCatalogConflictError(
      "Exact restore cleanup attempt has partial provider settlement authority",
    );
  }
  if (hasProviderReceipt) {
    requireSha256(attempt.provider_receipt_digest!, "attempt.providerReceiptDigest");
    if (attempt.locator_container_id === null) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore cleanup provider settlement lacks its Docker identity",
      );
    }
  }
  return hasProviderReceipt;
}

function assertExactRestoreCleanupOperationShape(
  operation: Readonly<AgentBackupRestoreOperation>,
  locator: Readonly<AgentSandboxReplacementLocatorInput>,
  retainsProviderSuccess: boolean,
  cleanupProven: boolean,
): void {
  if (cleanupProven) {
    if (operation.phase !== "vault_seeded" || operation.expected_container_id !== null) {
      throw new AgentBackupCatalogConflictError(
        "Proven exact restore cleanup requires rearmed vault_seeded authority",
      );
    }
    return;
  }
  if (retainsProviderSuccess) {
    if (
      operation.phase !== "container_created" ||
      operation.expected_container_id === null ||
      operation.expected_container_id !== locator.containerId
    ) {
      throw new AgentBackupCatalogConflictError(
        "Settled exact restore cleanup differs from atomic provider settlement",
      );
    }
    return;
  }
  if (operation.phase !== "vault_seeded" || operation.expected_container_id !== null) {
    throw new AgentBackupCatalogConflictError(
      "Unsettled exact restore cleanup requires vault_seeded pre-settlement authority",
    );
  }
}

function sandboxCreateAuthority(
  sandbox: AgentSandbox,
  operation: AgentBackupRestoreOperation,
): Readonly<AgentBackupRestoreSandboxCreateAuthority> {
  if (
    !sandbox.agent_name?.trim() ||
    !sandbox.docker_image?.trim() ||
    !CONTAINER_BACKED_EXECUTION_TIERS.some((tier) => tier === sandbox.execution_tier) ||
    sandbox.activation_generation !== operation.restore_attempt_id ||
    sandbox.activation_lifecycle_revision === null ||
    typeof sandbox.activation_token_hash !== "string" ||
    typeof sandbox.activation_token_ciphertext !== "string"
  ) {
    throw new AgentBackupCatalogConflictError(
      "Restore quarantine lacks exact container-backed sandbox create authority",
    );
  }
  return Object.freeze({
    agentId: sandbox.id,
    agentName: sandbox.agent_name,
    organizationId: sandbox.organization_id,
    executionTier: sandbox.execution_tier,
    environmentVars: Object.freeze({ ...sandbox.environment_vars }),
    agentConfig: sandbox.agent_config ? Object.freeze({ ...sandbox.agent_config }) : null,
    routeAgentId: sandbox.character_id,
    dockerImageReference: sandbox.docker_image,
    activationTokenSha256: requireSha256(
      sandbox.activation_token_hash,
      "sandbox.activationTokenSha256",
    ),
    activationTokenCiphertext: requireActivationTokenCiphertext(
      sandbox.activation_token_ciphertext,
    ),
    activationGeneration: operation.restore_attempt_id,
    lifecycleRevision: sandbox.activation_lifecycle_revision.toString(),
  });
}

function requireSha256(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new AgentBackupCatalogConflictError(`${field} must be a lowercase sha256 digest`);
  }
  return value;
}

function requireUuid(value: string, field: string): string {
  if (!isValidUUID(value) || value !== value.toLowerCase()) {
    throw new AgentBackupCatalogConflictError(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function requireCanonicalUint64(value: string, field: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new AgentBackupCatalogConflictError(`${field} must be a canonical uint64`);
  }
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) {
    throw new AgentBackupCatalogConflictError(`${field} must fit uint64`);
  }
  return parsed;
}

/**
 * Record the attempt so later phases have somewhere durable to land. Replaying
 * the same attempt returns the existing row; replaying it with different
 * authority is a conflict, never a silent adopt.
 */
export async function openAgentBackupRestoreOperation(
  input: OpenAgentBackupRestoreOperationInput,
): Promise<{ operation: Readonly<AgentBackupRestoreOperation>; replayed: boolean }> {
  const { authority } = input;
  const organizationId = requireUuid(authority.organizationId, "organizationId");
  const agentId = requireUuid(authority.agentId, "agentId");
  const backupId = requireUuid(authority.backupId, "backupId");
  const expectedOperationId = requireUuid(authority.operationId, "operationId");
  const expectedActivationGeneration = requireUuid(
    authority.sourceActivationGeneration,
    "sourceActivationGeneration",
  );
  const expectedLifecycleRevision = requireCanonicalUint64(
    authority.sourceLifecycleRevision,
    "sourceLifecycleRevision",
  );
  const expectedManifestSha256 = requireSha256(
    authority.expectedManifestSha256,
    "expectedManifestSha256",
  );
  const restoreAttemptId = requireUuid(authority.restoreAttemptId, "restoreAttemptId");
  const leaseId = requireUuid(input.leaseId, "leaseId");
  const fencingToken = requireUuid(authority.fencingToken, "fencingToken");
  const catalogEpoch = requireCanonicalUint64(authority.catalogEpoch, "catalogEpoch");
  requireOwnerId(authority.ownerId);

  return await dbWrite.transaction(async (tx) => {
    // The exact backup is the creation mutex for this durable attempt. Taking
    // it first lets concurrent response-loss replays observe the row inserted
    // by the winner before either transaction reaches lease/catalogue locks.
    const [backup] = await tx
      .select({ id: agentSandboxBackups.id })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, backupId),
          eq(agentSandboxBackups.catalog_organization_id, organizationId),
          eq(agentSandboxBackups.catalog_agent_id, agentId),
          eq(agentSandboxBackups.backup_operation_id, expectedOperationId),
          eq(agentSandboxBackups.lifecycle_generation, expectedActivationGeneration),
          eq(agentSandboxBackups.lifecycle_revision, expectedLifecycleRevision),
          eq(agentSandboxBackups.manifest_digest, expectedManifestSha256),
        ),
      )
      .for("update")
      .limit(1);
    if (!backup) {
      throw new AgentBackupCatalogConflictError("Restore backup authority does not match");
    }

    // An existing operation is locked before its lease. If it is absent, the
    // backup lock above serializes creation and makes the later insert unique.
    const [existing] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(
        and(
          eq(agentBackupRestoreOperations.organization_id, organizationId),
          eq(agentBackupRestoreOperations.restore_attempt_id, restoreAttemptId),
        ),
      )
      .for("update")
      .limit(1);

    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, leaseId),
          eq(agentBackupRestoreLeases.organization_id, organizationId),
          eq(agentBackupRestoreLeases.agent_id, agentId),
          eq(agentBackupRestoreLeases.backup_id, backupId),
          eq(agentBackupRestoreLeases.operation_id, expectedOperationId),
          eq(agentBackupRestoreLeases.activation_generation, expectedActivationGeneration),
          eq(agentBackupRestoreLeases.lifecycle_revision, expectedLifecycleRevision),
          eq(agentBackupRestoreLeases.expected_manifest_sha256, expectedManifestSha256),
          eq(agentBackupRestoreLeases.copy_role, authority.copyRole),
          eq(agentBackupRestoreLeases.restore_attempt_id, restoreAttemptId),
          eq(agentBackupRestoreLeases.generation, fencingToken),
          eq(agentBackupRestoreLeases.owner_id, authority.ownerId),
          eq(agentBackupRestoreLeases.catalog_epoch, catalogEpoch),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) {
      throw new AgentBackupCatalogConflictError("Restore lease authority does not match");
    }

    const catalogAuthority = await lockAgentBackupCatalogAuthority(tx, organizationId, agentId);

    // The catalogue epoch is re-proved here, not inherited from the receipt: a
    // revision advanced between acquire and open invalidates the attempt, and an
    // operation row is permanent once written.
    if (catalogAuthority.catalog_revision !== lease.catalog_epoch) {
      throw new AgentBackupCatalogConflictError(
        "Restore attempt was invalidated by a catalogue revision",
      );
    }

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at <= databaseNow) {
      throw new AgentBackupCatalogConflictError("Restore lease is expired or released");
    }

    if (existing) {
      if (
        existing.agent_id !== agentId ||
        existing.backup_id !== backupId ||
        existing.lease_id !== leaseId ||
        existing.lease_generation !== fencingToken ||
        existing.lease_owner_id !== authority.ownerId ||
        existing.catalog_epoch !== lease.catalog_epoch ||
        existing.copy_role !== lease.copy_role ||
        existing.expected_operation_id !== lease.operation_id ||
        existing.expected_manifest_sha256 !== lease.expected_manifest_sha256 ||
        existing.expected_activation_generation !== lease.activation_generation ||
        existing.expected_lifecycle_revision !== lease.lifecycle_revision
      ) {
        throw new AgentBackupCatalogConflictError("Restore operation replay authority mismatch");
      }
      return { operation: Object.freeze(existing), replayed: true };
    }

    const [created] = await tx
      .insert(agentBackupRestoreOperations)
      .values({
        organization_id: organizationId,
        agent_id: agentId,
        backup_id: backupId,
        restore_attempt_id: restoreAttemptId,
        lease_id: leaseId,
        lease_generation: fencingToken,
        lease_owner_id: authority.ownerId,
        catalog_epoch: lease.catalog_epoch,
        copy_role: lease.copy_role,
        expected_operation_id: lease.operation_id,
        expected_manifest_sha256: lease.expected_manifest_sha256,
        expected_activation_generation: lease.activation_generation,
        expected_lifecycle_revision: lease.lifecycle_revision,
      })
      .returning();
    if (!created) {
      throw new AgentBackupCatalogConflictError("Restore operation insert returned no row");
    }
    return { operation: Object.freeze(created), replayed: false };
  });
}

/**
 * Take a claim on one due operation. The row is re-locked inside the claiming
 * transaction and the lease is re-proved live; the claimant must be the lease's
 * own owner, because nobody else can renew the lease it will run under.
 */
export async function claimAgentBackupRestoreOperation(params: {
  operationId: string;
  ownerId: string;
  claimMs: number;
}): Promise<AgentBackupRestoreOperationClaim> {
  const operationId = requireUuid(params.operationId, "operationId");
  requireOwnerId(params.ownerId);
  if (
    !Number.isSafeInteger(params.claimMs) ||
    params.claimMs < MIN_CLAIM_MS ||
    params.claimMs > MAX_CLAIM_MS
  ) {
    throw new AgentBackupCatalogConflictError(
      `claimMs must be an integer between ${MIN_CLAIM_MS} and ${MAX_CLAIM_MS}`,
    );
  }

  return await dbWrite.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, operationId))
      .for("update")
      .limit(1);
    if (!operation) {
      throw new AgentBackupCatalogConflictError("Restore operation is missing");
    }
    if ((TERMINAL_PHASES as readonly string[]).includes(operation.phase)) {
      throw new AgentBackupCatalogConflictError(
        `Restore operation is terminal in phase ${operation.phase}`,
      );
    }

    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, operation.lease_id),
          eq(agentBackupRestoreLeases.organization_id, operation.organization_id),
          eq(agentBackupRestoreLeases.generation, operation.lease_generation),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) {
      throw new AgentBackupCatalogConflictError("Restore lease fence was lost");
    }

    if (lease.owner_id !== params.ownerId) {
      throw new AgentBackupCatalogConflictError("Restore lease belongs to another owner");
    }

    const [cleanupFence] = await tx
      .select({ id: agentSandboxReplacementAttempts.id })
      .from(agentSandboxReplacementAttempts)
      .where(
        and(
          eq(agentSandboxReplacementAttempts.organization_id, operation.organization_id),
          eq(agentSandboxReplacementAttempts.agent_id, operation.agent_id),
          eq(agentSandboxReplacementAttempts.operation_kind, "provision"),
          eq(agentSandboxReplacementAttempts.state, "cleanup_in_progress"),
          eq(agentSandboxReplacementAttempts.restore_lease_id, operation.lease_id),
          eq(agentSandboxReplacementAttempts.restore_backup_id, operation.backup_id),
          eq(agentSandboxReplacementAttempts.restore_attempt_id, operation.restore_attempt_id),
          eq(agentSandboxReplacementAttempts.restore_lease_generation, operation.lease_generation),
        ),
      )
      .for("update")
      .limit(1);
    if (cleanupFence) {
      throw new AgentBackupCatalogConflictError(
        "Restore operation cleanup must use its dedicated reconciliation claim",
      );
    }

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at <= databaseNow) {
      throw new AgentBackupCatalogConflictError("Restore lease is expired or released");
    }
    if (operation.claim_expires_at !== null && operation.claim_expires_at > databaseNow) {
      throw new AgentBackupCatalogConflictError("Restore operation is claimed by another worker");
    }
    if (operation.next_attempt_at > databaseNow) {
      throw new AgentBackupCatalogConflictError("Restore operation is not due yet");
    }

    const claimGeneration = crypto.randomUUID();
    const [claimed] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        claim_owner: params.ownerId,
        claim_generation: claimGeneration,
        claim_expires_at: new Date(databaseNow.getTime() + params.claimMs),
        attempts: operation.attempts + 1,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operationId),
          eq(agentBackupRestoreOperations.phase, operation.phase),
          notInArray(agentBackupRestoreOperations.phase, [...TERMINAL_PHASES]),
        ),
      )
      .returning();
    if (!claimed) {
      throw new AgentBackupCatalogConflictError("Restore operation claim lost its CAS");
    }
    return { operation: Object.freeze(claimed), claimGeneration, databaseNow };
  });
}

/**
 * Serialize remote cleanup independently from the restore lease lifetime. A
 * crashed cleanup worker can be replaced after its claim expires, but generic
 * restore reconciliation cannot cross the durable cleanup fence.
 */
export async function claimAgentSandboxExactRestoreCleanup(params: {
  operationId: string;
  ownerId: string;
  replacementAttemptId: string;
  claimMs: number;
}): Promise<AgentSandboxExactRestoreCleanupClaim> {
  const operationId = requireUuid(params.operationId, "operationId");
  const replacementAttemptId = requireUuid(params.replacementAttemptId, "replacementAttemptId");
  const ownerId = requireOwnerId(params.ownerId);
  if (
    !Number.isSafeInteger(params.claimMs) ||
    params.claimMs < MIN_CLAIM_MS ||
    params.claimMs > MAX_CLAIM_MS
  ) {
    throw new AgentBackupCatalogConflictError(
      `claimMs must be an integer between ${MIN_CLAIM_MS} and ${MAX_CLAIM_MS}`,
    );
  }

  return await dbWrite.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, operationId))
      .for("update")
      .limit(1);
    if (
      !operation ||
      operation.expected_node_record_id === null ||
      operation.expected_node_incarnation === null ||
      operation.expected_node_history_id === null ||
      operation.expected_image_digest === null
    ) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore cleanup claim requires complete target authority",
      );
    }
    if (operation.lease_owner_id !== ownerId) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore cleanup claim owner differs from immutable lease authority",
      );
    }

    const [attempt] = await tx
      .select()
      .from(agentSandboxReplacementAttempts)
      .where(
        and(
          eq(agentSandboxReplacementAttempts.id, replacementAttemptId),
          eq(agentSandboxReplacementAttempts.organization_id, operation.organization_id),
          eq(agentSandboxReplacementAttempts.agent_id, operation.agent_id),
          eq(agentSandboxReplacementAttempts.operation_kind, "provision"),
          inArray(agentSandboxReplacementAttempts.state, [
            "in_flight_unresolved",
            "cleanup_in_progress",
            "provider_succeeded",
            "cleanup_proven",
          ]),
          eq(agentSandboxReplacementAttempts.restore_lease_id, operation.lease_id),
          eq(agentSandboxReplacementAttempts.restore_backup_id, operation.backup_id),
          eq(agentSandboxReplacementAttempts.restore_attempt_id, operation.restore_attempt_id),
          eq(agentSandboxReplacementAttempts.restore_lease_owner_id, operation.lease_owner_id),
          eq(agentSandboxReplacementAttempts.restore_lease_generation, operation.lease_generation),
          eq(agentSandboxReplacementAttempts.restore_catalog_epoch, operation.catalog_epoch),
          eq(agentSandboxReplacementAttempts.restore_copy_role, operation.copy_role),
          eq(agentSandboxReplacementAttempts.restore_operation_id, operation.expected_operation_id),
          eq(
            agentSandboxReplacementAttempts.restore_source_activation_generation,
            operation.expected_activation_generation,
          ),
          eq(
            agentSandboxReplacementAttempts.restore_source_lifecycle_revision,
            operation.expected_lifecycle_revision,
          ),
          eq(
            agentSandboxReplacementAttempts.restore_manifest_sha256,
            operation.expected_manifest_sha256,
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (!attempt) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore cleanup attempt is missing, settled, or belongs to another authority",
      );
    }
    const locator = exactRestoreLocatorFromAttempt(attempt);
    if (
      locator.nodeRecordId !== operation.expected_node_record_id ||
      locator.nodeIncarnation !== operation.expected_node_incarnation ||
      locator.nodeHistoryId !== operation.expected_node_history_id
    ) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore cleanup locator differs from reserved occurrence authority",
      );
    }

    const retainsProviderSuccess = exactRestoreCleanupRetainsProviderSuccess(attempt);
    assertExactRestoreCleanupOperationShape(
      operation,
      locator,
      retainsProviderSuccess,
      attempt.state === "cleanup_proven",
    );
    const terminalStatus = attempt.state === "cleanup_proven" ? attempt.state : null;

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (terminalStatus) {
      return Object.freeze({
        status: terminalStatus,
        operation: Object.freeze(operation),
        attempt: Object.freeze(attempt),
        locator,
        claimGeneration: null,
        databaseNow,
      });
    }
    if (operation.claim_expires_at !== null && operation.claim_expires_at > databaseNow) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore cleanup is claimed by another reconciler",
      );
    }
    const claimGeneration = crypto.randomUUID();
    const [claimed] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        claim_owner: ownerId,
        claim_generation: claimGeneration,
        claim_expires_at: new Date(databaseNow.getTime() + params.claimMs),
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operation.id),
          eq(
            agentBackupRestoreOperations.phase,
            retainsProviderSuccess ? "container_created" : "vault_seeded",
          ),
          retainsProviderSuccess
            ? eq(agentBackupRestoreOperations.expected_container_id, locator.containerId!)
            : isNull(agentBackupRestoreOperations.expected_container_id),
          sql`(${agentBackupRestoreOperations.claim_expires_at} IS NULL OR ${agentBackupRestoreOperations.claim_expires_at} <= ${databaseNow})`,
        ),
      )
      .returning();
    if (!claimed) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore cleanup claim lost its serialization CAS",
      );
    }
    return Object.freeze({
      status: "claimed",
      operation: Object.freeze(claimed),
      attempt: Object.freeze(attempt),
      locator,
      claimGeneration,
      databaseNow,
    });
  });
}

/** Release a live cleanup-only claim after a remote cleanup error. */
export async function releaseAgentSandboxExactRestoreCleanupClaim(params: {
  operationId: string;
  ownerId: string;
  claimGeneration: string;
  replacementAttemptId: string;
}): Promise<Readonly<AgentBackupRestoreOperation>> {
  const operationId = requireUuid(params.operationId, "operationId");
  const ownerId = requireOwnerId(params.ownerId);
  const claimGeneration = requireUuid(params.claimGeneration, "claimGeneration");
  const replacementAttemptId = requireUuid(params.replacementAttemptId, "replacementAttemptId");

  return await dbWrite.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, operationId))
      .for("update")
      .limit(1);
    if (!operation || operation.lease_owner_id !== ownerId) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore cleanup claim release lost operation authority",
      );
    }
    const [attempt] = await tx
      .select()
      .from(agentSandboxReplacementAttempts)
      .where(
        and(
          eq(agentSandboxReplacementAttempts.id, replacementAttemptId),
          eq(agentSandboxReplacementAttempts.organization_id, operation.organization_id),
          eq(agentSandboxReplacementAttempts.agent_id, operation.agent_id),
          eq(agentSandboxReplacementAttempts.operation_kind, "provision"),
          inArray(agentSandboxReplacementAttempts.state, [
            "in_flight_unresolved",
            "provider_succeeded",
            "cleanup_in_progress",
          ]),
          eq(agentSandboxReplacementAttempts.restore_lease_id, operation.lease_id),
          eq(agentSandboxReplacementAttempts.restore_backup_id, operation.backup_id),
          eq(agentSandboxReplacementAttempts.restore_attempt_id, operation.restore_attempt_id),
          eq(agentSandboxReplacementAttempts.restore_lease_owner_id, operation.lease_owner_id),
          eq(agentSandboxReplacementAttempts.restore_lease_generation, operation.lease_generation),
          eq(agentSandboxReplacementAttempts.restore_catalog_epoch, operation.catalog_epoch),
          eq(agentSandboxReplacementAttempts.restore_copy_role, operation.copy_role),
          eq(agentSandboxReplacementAttempts.restore_operation_id, operation.expected_operation_id),
          eq(
            agentSandboxReplacementAttempts.restore_source_activation_generation,
            operation.expected_activation_generation,
          ),
          eq(
            agentSandboxReplacementAttempts.restore_source_lifecycle_revision,
            operation.expected_lifecycle_revision,
          ),
          eq(
            agentSandboxReplacementAttempts.restore_manifest_sha256,
            operation.expected_manifest_sha256,
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (!attempt) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore cleanup claim release lost attempt authority",
      );
    }
    const locator = exactRestoreLocatorFromAttempt(attempt);
    const retainsProviderSuccess = exactRestoreCleanupRetainsProviderSuccess(attempt);
    assertExactRestoreCleanupOperationShape(operation, locator, retainsProviderSuccess, false);
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (
      operation.claim_owner !== ownerId ||
      operation.claim_generation !== claimGeneration ||
      operation.claim_expires_at === null ||
      operation.claim_expires_at <= databaseNow
    ) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore cleanup claim release is stale or expired",
      );
    }
    const [released] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        claim_owner: null,
        claim_generation: null,
        claim_expires_at: null,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operation.id),
          eq(
            agentBackupRestoreOperations.phase,
            retainsProviderSuccess ? "container_created" : "vault_seeded",
          ),
          retainsProviderSuccess
            ? eq(agentBackupRestoreOperations.expected_container_id, locator.containerId!)
            : isNull(agentBackupRestoreOperations.expected_container_id),
          eq(agentBackupRestoreOperations.claim_owner, ownerId),
          eq(agentBackupRestoreOperations.claim_generation, claimGeneration),
          gt(agentBackupRestoreOperations.claim_expires_at, databaseNow),
        ),
      )
      .returning();
    if (!released) {
      throw new AgentBackupCatalogConflictError("Exact restore cleanup claim release lost its CAS");
    }
    return Object.freeze(released);
  });
}

/**
 * Relinquish a live worker claim without changing phase, retry scheduling, or
 * attempt accounting. This is the safe exit for exact replays that have no
 * remaining side effect for the current worker.
 */
export async function releaseAgentBackupRestoreOperationClaim(params: {
  operationId: string;
  ownerId: string;
  claimGeneration: string;
}): Promise<Readonly<AgentBackupRestoreOperation>> {
  const operationId = requireUuid(params.operationId, "operationId");
  const claimGeneration = requireUuid(params.claimGeneration, "claimGeneration");
  const ownerId = requireOwnerId(params.ownerId);

  return await dbWrite.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, operationId))
      .for("update")
      .limit(1);
    if (!operation) {
      throw new AgentBackupCatalogConflictError("Restore operation is missing");
    }
    if ((TERMINAL_PHASES as readonly string[]).includes(operation.phase)) {
      throw new AgentBackupCatalogConflictError(
        `Restore operation is terminal in phase ${operation.phase}`,
      );
    }

    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, operation.lease_id),
          eq(agentBackupRestoreLeases.organization_id, operation.organization_id),
          eq(agentBackupRestoreLeases.agent_id, operation.agent_id),
          eq(agentBackupRestoreLeases.generation, operation.lease_generation),
          eq(agentBackupRestoreLeases.owner_id, operation.lease_owner_id),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) {
      throw new AgentBackupCatalogConflictError("Restore lease fence was lost");
    }

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at <= databaseNow) {
      throw new AgentBackupCatalogConflictError("Restore lease is expired or released");
    }
    if (
      operation.lease_owner_id !== ownerId ||
      operation.claim_owner !== ownerId ||
      operation.claim_generation !== claimGeneration ||
      operation.claim_expires_at === null ||
      operation.claim_expires_at <= databaseNow
    ) {
      throw new AgentBackupCatalogConflictError("Restore operation claim is not live");
    }

    const [released] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        claim_owner: null,
        claim_generation: null,
        claim_expires_at: null,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operationId),
          eq(agentBackupRestoreOperations.phase, operation.phase),
          eq(agentBackupRestoreOperations.claim_owner, ownerId),
          eq(agentBackupRestoreOperations.claim_generation, claimGeneration),
          gt(agentBackupRestoreOperations.claim_expires_at, databaseNow),
        ),
      )
      .returning();
    if (!released) {
      throw new AgentBackupCatalogConflictError("Restore operation claim release lost its CAS");
    }
    return Object.freeze(released);
  });
}

/**
 * Atomically admit the exact, disabled-first restore create boundary.
 *
 * The caller selects one already-attested node occurrence. This writer never
 * discovers, autoscales, or reselects a target: it proves that occurrence,
 * reserves one existing slot, opens the sandbox quarantine, and writes the
 * complete replacement-attempt locator in one transaction. Consequently a
 * late conflict rolls every intent write back, while a lost response can
 * replay the same attempt without consuming another slot.
 */
export async function reserveAgentBackupRestoreTargetAndStartReplacementIntent(
  input: ReserveAgentBackupRestoreTargetAndStartReplacementIntentInput,
): Promise<ReserveAgentBackupRestoreTargetAndStartReplacementIntentResult> {
  const operationId = requireUuid(input.operationId, "operationId");
  const claimGeneration = requireUuid(input.claimGeneration, "claimGeneration");
  const targetNodeRecordId = requireUuid(input.targetNodeRecordId, "targetNodeRecordId");
  const targetNodeId = requireTargetNodeId(input.targetNodeId);
  const targetNodeIncarnation = requireUuid(input.targetNodeIncarnation, "targetNodeIncarnation");
  const targetNodeHistoryId = requireUuid(input.targetNodeHistoryId, "targetNodeHistoryId");
  const replacementAttemptId = requireUuid(input.replacementAttemptId, "replacementAttemptId");
  const activationTokenSha256 = requireSha256(input.activationTokenSha256, "activationTokenSha256");
  const activationTokenCiphertext = requireActivationTokenCiphertext(
    input.activationTokenCiphertext,
  );
  const ownerId = requireOwnerId(input.ownerId);

  // This read only supplies immutable tenant/source keys for the global lock
  // order. The operation is UPDATE-locked and compared again below. Mutable
  // target fields are deliberately excluded so a concurrent exact replay can
  // observe and adopt the winner's committed intent.
  const [operationAuthority] = await dbWrite
    .select()
    .from(agentBackupRestoreOperations)
    .where(eq(agentBackupRestoreOperations.id, operationId))
    .limit(1);
  if (!operationAuthority) {
    throw new AgentBackupCatalogConflictError("Restore operation is missing");
  }

  return await dbWrite.transaction(async (tx) => {
    // Global multi-authority order: organization -> backup -> operation ->
    // lease -> sandbox -> mutable node -> immutable occurrence -> catalogue.
    // All mutations happen only after that entire proof and a post-lock clock.
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, operationAuthority.organization_id))
      .for("key share")
      .limit(1);
    if (!organization) {
      throw new AgentBackupCatalogConflictError(
        "Restore replacement organization authority is missing",
      );
    }

    const [backup] = await tx
      .select({
        catalogState: agentSandboxBackups.catalog_state,
        manifestVersion: agentSandboxBackups.manifest_version,
        canonicalManifestDraft: agentSandboxBackups.manifest_canonical_draft,
        imageDigest: agentSandboxBackups.image_digest,
      })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, operationAuthority.backup_id),
          eq(agentSandboxBackups.catalog_organization_id, operationAuthority.organization_id),
          eq(agentSandboxBackups.catalog_agent_id, operationAuthority.agent_id),
          eq(agentSandboxBackups.backup_operation_id, operationAuthority.expected_operation_id),
          eq(
            agentSandboxBackups.lifecycle_generation,
            operationAuthority.expected_activation_generation,
          ),
          eq(
            agentSandboxBackups.lifecycle_revision,
            operationAuthority.expected_lifecycle_revision,
          ),
          eq(agentSandboxBackups.manifest_digest, operationAuthority.expected_manifest_sha256),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !backup ||
      !hasAgentBackupRestoreAuthority(backup.catalogState) ||
      backup.manifestVersion !== 3 ||
      !backup.canonicalManifestDraft ||
      !backup.imageDigest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore target source is absent, non-restorable, or lacks manifest-v3 authority",
      );
    }
    const parsedManifest = await parseAgentBackupManifestV3Authority({
      canonicalManifestDraft: backup.canonicalManifestDraft,
      expectedManifestSha256: operationAuthority.expected_manifest_sha256,
    });
    const manifest = parsedManifest.manifest;
    if (
      manifest.operationId !== operationAuthority.expected_operation_id ||
      manifest.identity.organizationId !== operationAuthority.organization_id ||
      manifest.identity.agentId !== operationAuthority.agent_id ||
      manifest.identity.activationGeneration !==
        operationAuthority.expected_activation_generation ||
      manifest.identity.lifecycleRevision !==
        operationAuthority.expected_lifecycle_revision.toString() ||
      manifest.runtime.imageDigest !== backup.imageDigest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore target image differs from its exact manifest-v3 authority",
      );
    }

    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, operationId))
      .for("update")
      .limit(1);
    if (!operation) {
      throw new AgentBackupCatalogConflictError("Restore operation is missing");
    }
    if (!immutableOperationAuthorityMatches(operation, operationAuthority)) {
      throw new AgentBackupCatalogConflictError("Restore operation authority changed before lock");
    }
    if (
      operation.phase !== "reserved" &&
      operation.phase !== "vault_seeded" &&
      operation.phase !== "container_created"
    ) {
      throw new AgentBackupCatalogConflictError(
        `Restore replacement authority cannot load phase ${operation.phase}`,
      );
    }

    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, operation.lease_id),
          eq(agentBackupRestoreLeases.organization_id, operation.organization_id),
          eq(agentBackupRestoreLeases.agent_id, operation.agent_id),
          eq(agentBackupRestoreLeases.backup_id, operation.backup_id),
          eq(agentBackupRestoreLeases.operation_id, operation.expected_operation_id),
          eq(
            agentBackupRestoreLeases.activation_generation,
            operation.expected_activation_generation,
          ),
          eq(agentBackupRestoreLeases.lifecycle_revision, operation.expected_lifecycle_revision),
          eq(agentBackupRestoreLeases.expected_manifest_sha256, operation.expected_manifest_sha256),
          eq(agentBackupRestoreLeases.copy_role, operation.copy_role),
          eq(agentBackupRestoreLeases.restore_attempt_id, operation.restore_attempt_id),
          eq(agentBackupRestoreLeases.owner_id, operation.lease_owner_id),
          eq(agentBackupRestoreLeases.generation, operation.lease_generation),
          eq(agentBackupRestoreLeases.catalog_epoch, operation.catalog_epoch),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) {
      throw new AgentBackupCatalogConflictError("Restore lease fence was lost");
    }

    const [sandbox] = await tx
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, operation.agent_id),
          eq(agentSandboxes.organization_id, operation.organization_id),
          isNull(agentSandboxes.deleted_at),
        ),
      )
      .for("update")
      .limit(1);
    if (!sandbox) {
      throw new AgentBackupCatalogConflictError("Restore sandbox authority is missing or deleted");
    }

    const [node] = await tx
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, targetNodeRecordId))
      .for("update")
      .limit(1);
    if (!node || node.node_id !== targetNodeId) {
      throw new AgentBackupCatalogConflictError("Restore target node identity changed");
    }
    if (node.node_incarnation !== targetNodeIncarnation) {
      throw new AgentBackupCatalogConflictError("Restore target node incarnation changed");
    }
    if (node.current_node_history_id !== targetNodeHistoryId) {
      throw new AgentBackupCatalogConflictError("Restore target node occurrence changed");
    }
    await proveExactAgentNodeOccurrenceForLockedNode(
      tx,
      node,
      targetNodeIncarnation,
      targetNodeHistoryId,
    );
    const targetPlatform = requireNodeExactImagePlatform(node.metadata);

    const catalogAuthority = await lockAgentBackupCatalogAuthority(
      tx,
      operation.organization_id,
      operation.agent_id,
    );
    if (catalogAuthority.catalog_revision !== operation.catalog_epoch) {
      throw new AgentBackupCatalogConflictError(
        "Restore target authority was invalidated by a catalogue revision",
      );
    }

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at <= databaseNow) {
      throw new AgentBackupCatalogConflictError("Restore lease is expired or released");
    }
    if (
      operation.claim_owner !== ownerId ||
      operation.claim_generation !== claimGeneration ||
      operation.claim_expires_at === null ||
      operation.claim_expires_at <= databaseNow
    ) {
      throw new AgentBackupCatalogConflictError("Restore operation claim is not live");
    }

    const target = Object.freeze({
      nodeRecordId: node.id,
      nodeId: node.node_id,
      nodeIncarnation: targetNodeIncarnation,
      nodeHistoryId: targetNodeHistoryId,
      imageDigest: manifest.runtime.imageDigest,
      platform: targetPlatform,
      imageReference: operation.expected_image_reference,
      imagePlatformDigest: operation.expected_image_platform_digest,
    });
    const targetFieldCount = [
      operation.expected_node_record_id,
      operation.expected_node_incarnation,
      operation.expected_node_history_id,
      operation.expected_image_digest,
      operation.expected_image_platform,
    ].filter((value) => value !== null).length;
    if (targetFieldCount !== 0 && targetFieldCount !== 5) {
      throw new AgentBackupCatalogConflictError("Restore target authority is only partially set");
    }
    if (
      (operation.expected_image_reference === null) !==
      (operation.expected_image_platform_digest === null)
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore exact image platform authority is only partially set",
      );
    }
    const targetAlreadyRecorded = targetFieldCount === 5;
    if (!targetAlreadyRecorded && operation.expected_image_reference !== null) {
      throw new AgentBackupCatalogConflictError(
        "Restore exact image authority exists without its reserved target",
      );
    }
    if (
      targetAlreadyRecorded &&
      (operation.expected_node_record_id !== target.nodeRecordId ||
        operation.expected_node_incarnation !== target.nodeIncarnation ||
        operation.expected_node_history_id !== target.nodeHistoryId ||
        operation.expected_image_digest !== target.imageDigest ||
        operation.expected_image_platform !== target.platform)
    ) {
      throw new AgentBackupCatalogConflictError("Restore target replay authority mismatch");
    }

    // Response-loss replay is identified by the exact active restore authority,
    // not by a newly generated caller UUID. The committed attempt ID becomes
    // canonical; after cleanup no active row exists and a new one-shot UUID is
    // required for the next provider effect.
    const [existingAttempt] = await tx
      .select()
      .from(agentSandboxReplacementAttempts)
      .where(
        and(
          eq(agentSandboxReplacementAttempts.organization_id, operation.organization_id),
          eq(agentSandboxReplacementAttempts.agent_id, operation.agent_id),
          inArray(agentSandboxReplacementAttempts.state, [
            "in_flight_unresolved",
            "provider_succeeded",
            "cleanup_in_progress",
          ]),
          eq(agentSandboxReplacementAttempts.operation_kind, "provision"),
          eq(agentSandboxReplacementAttempts.restore_lease_id, operation.lease_id),
          eq(agentSandboxReplacementAttempts.restore_backup_id, operation.backup_id),
          eq(agentSandboxReplacementAttempts.restore_attempt_id, operation.restore_attempt_id),
          eq(agentSandboxReplacementAttempts.restore_lease_owner_id, operation.lease_owner_id),
          eq(agentSandboxReplacementAttempts.restore_lease_generation, operation.lease_generation),
          eq(agentSandboxReplacementAttempts.restore_catalog_epoch, operation.catalog_epoch),
          eq(agentSandboxReplacementAttempts.restore_copy_role, operation.copy_role),
          eq(agentSandboxReplacementAttempts.restore_operation_id, operation.expected_operation_id),
          eq(
            agentSandboxReplacementAttempts.restore_source_activation_generation,
            operation.expected_activation_generation,
          ),
          eq(
            agentSandboxReplacementAttempts.restore_source_lifecycle_revision,
            operation.expected_lifecycle_revision,
          ),
          eq(
            agentSandboxReplacementAttempts.restore_manifest_sha256,
            operation.expected_manifest_sha256,
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (existingAttempt && !targetAlreadyRecorded) {
      throw new AgentBackupCatalogConflictError(
        "Restore replacement intent exists without its atomic target reservation",
      );
    }
    let priorCleanupProvesRelease = false;
    if (!existingAttempt && targetAlreadyRecorded) {
      const [priorCleanup] = await tx
        .select({ id: agentSandboxReplacementAttempts.id })
        .from(agentSandboxReplacementAttempts)
        .where(
          and(
            eq(agentSandboxReplacementAttempts.organization_id, operation.organization_id),
            eq(agentSandboxReplacementAttempts.agent_id, operation.agent_id),
            eq(agentSandboxReplacementAttempts.state, "cleanup_proven"),
            eq(agentSandboxReplacementAttempts.restore_lease_id, operation.lease_id),
            eq(agentSandboxReplacementAttempts.restore_backup_id, operation.backup_id),
            eq(agentSandboxReplacementAttempts.restore_attempt_id, operation.restore_attempt_id),
            eq(
              agentSandboxReplacementAttempts.restore_lease_generation,
              operation.lease_generation,
            ),
            eq(agentSandboxReplacementAttempts.restore_lease_owner_id, operation.lease_owner_id),
            eq(agentSandboxReplacementAttempts.restore_catalog_epoch, operation.catalog_epoch),
            eq(agentSandboxReplacementAttempts.restore_copy_role, operation.copy_role),
            eq(
              agentSandboxReplacementAttempts.restore_operation_id,
              operation.expected_operation_id,
            ),
            eq(
              agentSandboxReplacementAttempts.restore_source_activation_generation,
              operation.expected_activation_generation,
            ),
            eq(
              agentSandboxReplacementAttempts.restore_source_lifecycle_revision,
              operation.expected_lifecycle_revision,
            ),
            eq(
              agentSandboxReplacementAttempts.restore_manifest_sha256,
              operation.expected_manifest_sha256,
            ),
            eq(agentSandboxReplacementAttempts.locator_node_record_id, target.nodeRecordId),
            eq(agentSandboxReplacementAttempts.locator_node_id, target.nodeId),
            eq(agentSandboxReplacementAttempts.locator_node_incarnation, target.nodeIncarnation),
            eq(agentSandboxReplacementAttempts.locator_node_history_id, target.nodeHistoryId),
            eq(agentSandboxReplacementAttempts.locator_allocation_counted, true),
          ),
        )
        .for("update")
        .limit(1);
      priorCleanupProvesRelease = priorCleanup !== undefined;
      if (!priorCleanupProvesRelease) {
        throw new AgentBackupCatalogConflictError(
          "Recorded restore target has no exact replacement intent or cleanup release proof",
        );
      }
    }
    if (
      !existingAttempt &&
      operation.phase !== "reserved" &&
      !(operation.phase === "vault_seeded" && priorCleanupProvesRelease)
    ) {
      throw new AgentBackupCatalogConflictError(
        `Restore ${operation.phase} phase lost its canonical active replacement intent`,
      );
    }

    const intentAttemptId = existingAttempt?.id ?? replacementAttemptId;
    const adoptPersistedQuarantine = existingAttempt !== undefined || priorCleanupProvesRelease;
    const canonicalActivationTokenSha256 = adoptPersistedQuarantine
      ? requireSha256(sandbox.activation_token_hash ?? "", "sandbox.activationTokenSha256")
      : activationTokenSha256;
    const canonicalActivationTokenCiphertext = adoptPersistedQuarantine
      ? requireActivationTokenCiphertext(sandbox.activation_token_ciphertext ?? "")
      : activationTokenCiphertext;

    const targetEligibleForFirstPlacement =
      node.enabled &&
      node.status === "healthy" &&
      node.placement_state === PLACEABLE_NODE_STATE &&
      node.metadata.capacityProvisional !== true;
    if (!existingAttempt) {
      if (!targetEligibleForFirstPlacement) {
        throw new AgentBackupCatalogConflictError(
          "Restore target is not an enabled, healthy, open existing node",
        );
      }
      if (node.allocated_count >= node.capacity) {
        throw new AgentBackupCatalogConflictError("Restore target has no existing capacity");
      }
      const [reservedNode] = await tx
        .update(dockerNodes)
        .set({
          allocated_count: sql`${dockerNodes.allocated_count} + 1`,
          updated_at: databaseNow,
        })
        .where(
          and(
            eq(dockerNodes.id, targetNodeRecordId),
            eq(dockerNodes.node_id, targetNodeId),
            eq(dockerNodes.node_incarnation, targetNodeIncarnation),
            eq(dockerNodes.current_node_history_id, targetNodeHistoryId),
            eq(dockerNodes.enabled, true),
            eq(dockerNodes.status, "healthy"),
            eq(dockerNodes.placement_state, PLACEABLE_NODE_STATE),
            sql`COALESCE(${dockerNodes.metadata}->>'capacityProvisional', 'false') <> 'true'`,
            sql`${dockerNodes.allocated_count} < ${dockerNodes.capacity}`,
          ),
        )
        .returning({ id: dockerNodes.id });
      if (!reservedNode) {
        throw new AgentBackupCatalogConflictError(
          "Restore target capacity reservation lost its CAS",
        );
      }
    }

    let operationForIntent = operation;
    if (!targetAlreadyRecorded) {
      const [reservedOperation] = await tx
        .update(agentBackupRestoreOperations)
        .set({
          expected_node_record_id: target.nodeRecordId,
          expected_node_incarnation: target.nodeIncarnation,
          expected_node_history_id: target.nodeHistoryId,
          expected_image_digest: target.imageDigest,
          expected_image_platform: target.platform,
          updated_at: databaseNow,
        })
        .where(
          and(
            eq(agentBackupRestoreOperations.id, operationId),
            eq(agentBackupRestoreOperations.phase, "reserved"),
            eq(agentBackupRestoreOperations.claim_owner, ownerId),
            eq(agentBackupRestoreOperations.claim_generation, claimGeneration),
            isNull(agentBackupRestoreOperations.expected_node_record_id),
            isNull(agentBackupRestoreOperations.expected_node_incarnation),
            isNull(agentBackupRestoreOperations.expected_node_history_id),
            isNull(agentBackupRestoreOperations.expected_image_digest),
            isNull(agentBackupRestoreOperations.expected_image_platform),
          ),
        )
        .returning();
      if (!reservedOperation) {
        throw new AgentBackupCatalogConflictError("Restore target reservation lost its CAS");
      }
      operationForIntent = reservedOperation;
    }

    const quarantine =
      operationForIntent.phase === "container_created"
        ? (() => {
            verifyAgentBackupRestoreQuarantineForLockedAuthorities({
              operation: operationForIntent,
              sandbox,
              activationTokenSha256: canonicalActivationTokenSha256,
              activationTokenCiphertext: canonicalActivationTokenCiphertext,
              nodeId: node.node_id,
            });
            return { sandbox: Object.freeze(sandbox), replayed: true };
          })()
        : await openAgentBackupRestoreQuarantineForLockedAuthoritiesInTransaction(tx, {
            operation: operationForIntent,
            sandbox,
            activationTokenSha256: canonicalActivationTokenSha256,
            activationTokenCiphertext: canonicalActivationTokenCiphertext,
            databaseNow,
            targetEligibleForFirstPlacement,
          });
    const quarantinedSandbox = quarantine.sandbox;
    if (quarantinedSandbox.activation_lifecycle_revision === null) {
      throw new AgentBackupCatalogConflictError(
        "Restore quarantine did not bind a lifecycle revision",
      );
    }
    if (!node.host_key_fingerprint?.trim()) {
      throw new AgentBackupCatalogConflictError(
        "Restore target lacks a pinned SSH host-key fingerprint",
      );
    }

    const containerName = exactRestoreContainerName(
      operation.agent_id,
      operation.restore_attempt_id,
    );
    const locator: Readonly<AgentSandboxReplacementLocatorInput> = Object.freeze({
      replacementAttemptId: intentAttemptId,
      sandboxId: containerName,
      nodeId: node.node_id,
      containerName,
      nodeRecordId: node.id,
      nodeIncarnation: targetNodeIncarnation,
      nodeHistoryId: targetNodeHistoryId,
      nodeHostname: node.hostname,
      nodeSshPort: node.ssh_port,
      nodeSshUser: node.ssh_user,
      nodeHostKeyFingerprint: node.host_key_fingerprint,
      replacementSecretCleanupVersion: 1,
      allocationCounted: true,
      vpnNodeName: null,
      vpnRegistrationStartedAt: null,
      previousVpnNodeId: null,
      containerId: null,
      vpnNodeId: null,
    });
    const replacement = await startOrReplayExactRestoreReplacementIntentInTransaction(tx, {
      attemptId: intentAttemptId,
      organizationId: operation.organization_id,
      agentId: operation.agent_id,
      lifecycleRevision:
        existingAttempt?.lifecycle_revision.toString() ??
        quarantinedSandbox.activation_lifecycle_revision.toString(),
      activationGeneration: operation.restore_attempt_id,
      lifecycleJobId: existingAttempt?.lifecycle_job_id ?? quarantinedSandbox.lifecycle_job_id,
      lifecycleExecutionGeneration:
        existingAttempt?.lifecycle_execution_generation ??
        quarantinedSandbox.lifecycle_execution_generation,
      restoreAuthority: {
        leaseId: lease.id,
        backupId: lease.backup_id,
        restoreAttemptId: lease.restore_attempt_id,
        ownerId: lease.owner_id,
        fencingToken: lease.generation,
        catalogEpoch: lease.catalog_epoch.toString(),
        copyRole: lease.copy_role,
        operationId: lease.operation_id,
        sourceActivationGeneration: lease.activation_generation,
        sourceLifecycleRevision: lease.lifecycle_revision.toString(),
        expectedManifestSha256: lease.expected_manifest_sha256,
        expiresAt: new Date(lease.expires_at.getTime()),
      },
      locator,
      databaseNow,
    });
    if (replacement.replayed !== (existingAttempt !== undefined)) {
      throw new AgentBackupCatalogConflictError(
        "Restore replacement intent replay classification changed under lock",
      );
    }

    if (
      operationForIntent.phase === "vault_seeded" &&
      replacement.attempt.locator_container_id !== null
    ) {
      throw new AgentBackupCatalogConflictError(
        "Vault-seeded restore cannot replay an already-created replacement container",
      );
    }
    if (
      operationForIntent.phase === "container_created" &&
      replacement.attempt.locator_container_id !== operationForIntent.expected_container_id
    ) {
      throw new AgentBackupCatalogConflictError(
        "Container-created restore differs from replacement Docker enrichment",
      );
    }
    const canonicalLocator: Readonly<AgentSandboxReplacementLocatorInput> = Object.freeze({
      ...locator,
      containerId: replacement.attempt.locator_container_id,
      vpnNodeId: replacement.attempt.locator_vpn_node_id,
    });

    return Object.freeze({
      operation: Object.freeze(operationForIntent),
      target,
      sandbox: sandboxCreateAuthority(quarantinedSandbox, operationForIntent),
      attempt: replacement.attempt,
      locator: canonicalLocator,
      replayed: Object.freeze({
        target: targetAlreadyRecorded,
        quarantine: quarantine.replayed,
        replacementIntent: replacement.replayed,
      }),
    });
  });
}

/**
 * Bind the registry-verified child manifest after vault seeding and before the
 * first provider effect. The node platform was already frozen at reservation;
 * this CAS only accepts the canonical GHCR parent reference and exact child
 * digest selected for that platform. A response-loss replay adopts the
 * byte-identical winner, including after atomic provider settlement.
 */
export async function recordAgentBackupRestoreExactImagePlatformAuthority(
  input: RecordAgentBackupRestoreExactImagePlatformAuthorityInput,
): Promise<RecordAgentBackupRestoreExactImagePlatformAuthorityResult> {
  const operationId = requireUuid(input.operationId, "operationId");
  const claimGeneration = requireUuid(input.claimGeneration, "claimGeneration");
  const ownerId = requireOwnerId(input.ownerId);
  const imagePlatformDigest = requireImageDigest(input.imagePlatformDigest, "imagePlatformDigest");

  // The first read supplies only immutable lock-order keys and the write-once
  // parent digest. Exact reference fields are deliberately re-read under lock
  // so concurrent response-loss callers can adopt the committed winner.
  const [operationAuthority] = await dbWrite
    .select()
    .from(agentBackupRestoreOperations)
    .where(eq(agentBackupRestoreOperations.id, operationId))
    .limit(1);
  if (!operationAuthority) {
    throw new AgentBackupCatalogConflictError("Restore operation is missing");
  }
  if (
    operationAuthority.expected_node_record_id === null ||
    operationAuthority.expected_node_incarnation === null ||
    operationAuthority.expected_node_history_id === null ||
    operationAuthority.expected_image_digest === null ||
    operationAuthority.expected_image_platform === null
  ) {
    throw new AgentBackupCatalogConflictError(
      "Restore exact image binding requires complete reserved target authority",
    );
  }
  const imageReference = requireExactGhcrImageReference(
    input.imageReference,
    operationAuthority.expected_image_digest,
  );

  return await dbWrite.transaction(async (tx) => {
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, operationAuthority.organization_id))
      .for("key share")
      .limit(1);
    if (!organization) {
      throw new AgentBackupCatalogConflictError(
        "Restore exact image organization authority is missing",
      );
    }

    const [backup] = await tx
      .select({
        catalogState: agentSandboxBackups.catalog_state,
        manifestVersion: agentSandboxBackups.manifest_version,
        canonicalManifestDraft: agentSandboxBackups.manifest_canonical_draft,
        imageDigest: agentSandboxBackups.image_digest,
      })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, operationAuthority.backup_id),
          eq(agentSandboxBackups.catalog_organization_id, operationAuthority.organization_id),
          eq(agentSandboxBackups.catalog_agent_id, operationAuthority.agent_id),
          eq(agentSandboxBackups.backup_operation_id, operationAuthority.expected_operation_id),
          eq(
            agentSandboxBackups.lifecycle_generation,
            operationAuthority.expected_activation_generation,
          ),
          eq(
            agentSandboxBackups.lifecycle_revision,
            operationAuthority.expected_lifecycle_revision,
          ),
          eq(agentSandboxBackups.manifest_digest, operationAuthority.expected_manifest_sha256),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !backup ||
      !hasAgentBackupRestoreAuthority(backup.catalogState) ||
      backup.manifestVersion !== 3 ||
      !backup.canonicalManifestDraft ||
      backup.imageDigest !== operationAuthority.expected_image_digest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore exact image source lost manifest-v3 authority",
      );
    }
    const { manifest } = await parseAgentBackupManifestV3Authority({
      canonicalManifestDraft: backup.canonicalManifestDraft,
      expectedManifestSha256: operationAuthority.expected_manifest_sha256,
    });
    if (
      manifest.operationId !== operationAuthority.expected_operation_id ||
      manifest.identity.organizationId !== operationAuthority.organization_id ||
      manifest.identity.agentId !== operationAuthority.agent_id ||
      manifest.identity.activationGeneration !==
        operationAuthority.expected_activation_generation ||
      manifest.identity.lifecycleRevision !==
        operationAuthority.expected_lifecycle_revision.toString() ||
      manifest.runtime.imageDigest !== operationAuthority.expected_image_digest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore exact image manifest authority diverged from its operation",
      );
    }

    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, operationId))
      .for("update")
      .limit(1);
    if (
      !operation ||
      !immutableOperationAuthorityMatches(operation, operationAuthority) ||
      operation.expected_node_record_id !== operationAuthority.expected_node_record_id ||
      operation.expected_node_incarnation !== operationAuthority.expected_node_incarnation ||
      operation.expected_node_history_id !== operationAuthority.expected_node_history_id ||
      operation.expected_image_digest !== operationAuthority.expected_image_digest ||
      operation.expected_image_platform !== operationAuthority.expected_image_platform
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore exact image target authority changed before lock",
      );
    }
    const targetNodeRecordId = operation.expected_node_record_id;
    const targetNodeIncarnation = operation.expected_node_incarnation;
    const targetNodeHistoryId = operation.expected_node_history_id;
    const targetImageDigest = operation.expected_image_digest;
    const targetPlatform = operation.expected_image_platform;
    if (
      targetNodeRecordId === null ||
      targetNodeIncarnation === null ||
      targetNodeHistoryId === null ||
      targetImageDigest === null ||
      targetPlatform === null
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore exact image target authority is incomplete under lock",
      );
    }

    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, operation.lease_id),
          eq(agentBackupRestoreLeases.organization_id, operation.organization_id),
          eq(agentBackupRestoreLeases.agent_id, operation.agent_id),
          eq(agentBackupRestoreLeases.backup_id, operation.backup_id),
          eq(agentBackupRestoreLeases.restore_attempt_id, operation.restore_attempt_id),
          eq(agentBackupRestoreLeases.owner_id, operation.lease_owner_id),
          eq(agentBackupRestoreLeases.generation, operation.lease_generation),
          eq(agentBackupRestoreLeases.catalog_epoch, operation.catalog_epoch),
          eq(agentBackupRestoreLeases.copy_role, operation.copy_role),
          eq(agentBackupRestoreLeases.operation_id, operation.expected_operation_id),
          eq(
            agentBackupRestoreLeases.activation_generation,
            operation.expected_activation_generation,
          ),
          eq(agentBackupRestoreLeases.lifecycle_revision, operation.expected_lifecycle_revision),
          eq(agentBackupRestoreLeases.expected_manifest_sha256, operation.expected_manifest_sha256),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) {
      throw new AgentBackupCatalogConflictError("Restore exact image lease fence was lost");
    }

    const [node] = await tx
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, targetNodeRecordId))
      .for("update")
      .limit(1);
    if (
      !node ||
      node.node_incarnation !== targetNodeIncarnation ||
      node.current_node_history_id !== targetNodeHistoryId
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore exact image target node occurrence changed",
      );
    }
    await proveExactAgentNodeOccurrenceForLockedNode(
      tx,
      node,
      targetNodeIncarnation,
      targetNodeHistoryId,
    );
    if (requireNodeExactImagePlatform(node.metadata) !== targetPlatform) {
      throw new AgentBackupCatalogConflictError(
        "Restore exact image target platform differs from reserved authority",
      );
    }

    const catalogAuthority = await lockAgentBackupCatalogAuthority(
      tx,
      operation.organization_id,
      operation.agent_id,
    );
    if (catalogAuthority.catalog_revision !== operation.catalog_epoch) {
      throw new AgentBackupCatalogConflictError(
        "Restore exact image authority was invalidated by a catalogue revision",
      );
    }

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at <= databaseNow) {
      throw new AgentBackupCatalogConflictError("Restore exact image lease is expired or released");
    }
    const referenceIsSet = operation.expected_image_reference !== null;
    const platformDigestIsSet = operation.expected_image_platform_digest !== null;
    if (referenceIsSet !== platformDigestIsSet) {
      throw new AgentBackupCatalogConflictError(
        "Restore exact image platform authority is only partially set",
      );
    }
    const settledReplay =
      referenceIsSet &&
      operation.phase === "container_created" &&
      operation.expected_container_id !== null;
    const claimIsLive =
      operation.claim_owner === ownerId &&
      operation.claim_generation === claimGeneration &&
      operation.claim_expires_at !== null &&
      operation.claim_expires_at > databaseNow;
    // Provider settlement atomically consumes its claim. Permit only an
    // immutable, byte-identical read replay when no later worker owns the
    // operation and the caller is still the durable lease owner. The consumed
    // claim generation is intentionally not reconstructed or caller-trusted.
    const unclaimedSettledReplay =
      settledReplay &&
      operation.claim_owner === null &&
      operation.claim_generation === null &&
      operation.claim_expires_at === null &&
      operation.lease_owner_id === ownerId;
    if (!claimIsLive && !unclaimedSettledReplay) {
      throw new AgentBackupCatalogConflictError("Restore exact image operation claim is not live");
    }

    if (referenceIsSet) {
      if (
        (operation.phase !== "vault_seeded" || operation.expected_container_id !== null) &&
        !settledReplay
      ) {
        throw new AgentBackupCatalogConflictError(
          "Restore exact image authority cannot replay from this phase",
        );
      }
      if (
        operation.expected_image_reference !== imageReference ||
        operation.expected_image_platform_digest !== imagePlatformDigest
      ) {
        throw new AgentBackupCatalogConflictError(
          "Restore exact image platform authority replay mismatch",
        );
      }
      return Object.freeze({
        operation: Object.freeze(operation),
        target: Object.freeze({
          nodeRecordId: node.id,
          nodeId: node.node_id,
          nodeIncarnation: targetNodeIncarnation,
          nodeHistoryId: targetNodeHistoryId,
          imageDigest: targetImageDigest,
          platform: targetPlatform,
          imageReference,
          imagePlatformDigest,
        }),
        replayed: true,
      });
    }
    if (operation.phase !== "vault_seeded" || operation.expected_container_id !== null) {
      throw new AgentBackupCatalogConflictError(
        "Restore exact image authority can first bind only in vault_seeded phase",
      );
    }

    const [recorded] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        expected_image_reference: imageReference,
        expected_image_platform_digest: imagePlatformDigest,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operation.id),
          eq(agentBackupRestoreOperations.phase, "vault_seeded"),
          isNull(agentBackupRestoreOperations.expected_container_id),
          eq(agentBackupRestoreOperations.claim_owner, ownerId),
          eq(agentBackupRestoreOperations.claim_generation, claimGeneration),
          gt(agentBackupRestoreOperations.claim_expires_at, databaseNow),
          isNull(agentBackupRestoreOperations.expected_image_reference),
          isNull(agentBackupRestoreOperations.expected_image_platform_digest),
        ),
      )
      .returning();
    if (!recorded) {
      throw new AgentBackupCatalogConflictError(
        "Restore exact image platform authority lost its CAS",
      );
    }
    return Object.freeze({
      operation: Object.freeze(recorded),
      target: Object.freeze({
        nodeRecordId: node.id,
        nodeId: node.node_id,
        nodeIncarnation: recorded.expected_node_incarnation!,
        nodeHistoryId: recorded.expected_node_history_id!,
        imageDigest: recorded.expected_image_digest!,
        platform: recorded.expected_image_platform!,
        imageReference,
        imagePlatformDigest,
      }),
      replayed: false,
    });
  });
}

type ExactRestoreProviderBoundaryMode =
  | "start"
  | "created"
  | "succeed"
  | "begin_cleanup"
  | "finish_cleanup";

async function runAgentSandboxExactRestoreProviderBoundary(
  input:
    | AgentSandboxExactRestoreProviderBoundaryInput
    | BeginAgentSandboxExactRestoreCleanupInput
    | FinishAgentSandboxExactRestoreCleanupInput,
  mode: ExactRestoreProviderBoundaryMode,
  receiptDigest?: string,
): Promise<AgentSandboxExactRestoreProviderBoundaryResult> {
  const operationId = requireUuid(input.operationId, "operationId");
  const replacementAttemptId = requireUuid(input.replacementAttemptId, "replacementAttemptId");
  const finishCleanup = mode === "finish_cleanup";
  const cleanupBoundary = mode === "begin_cleanup" || finishCleanup;
  const claimedInput = input as AgentSandboxExactRestoreProviderBoundaryInput;
  const claimGeneration = requireUuid(claimedInput.claimGeneration, "claimGeneration");
  const ownerId = requireOwnerId(claimedInput.ownerId);
  const suppliedLocator = "locator" in input ? input.locator : null;
  if (
    mode !== "begin_cleanup" &&
    (typeof suppliedLocator !== "object" || suppliedLocator === null)
  ) {
    throw new AgentBackupCatalogConflictError("Exact restore provider locator must be an object");
  }
  if (suppliedLocator && suppliedLocator.replacementAttemptId !== replacementAttemptId) {
    throw new AgentBackupCatalogConflictError(
      "Exact restore provider locator belongs to another replacement attempt",
    );
  }

  const [operationAuthority] = await dbWrite
    .select()
    .from(agentBackupRestoreOperations)
    .where(eq(agentBackupRestoreOperations.id, operationId))
    .limit(1);
  if (!operationAuthority) {
    throw new AgentBackupCatalogConflictError("Restore operation is missing");
  }
  if (
    operationAuthority.expected_node_record_id === null ||
    operationAuthority.expected_node_incarnation === null ||
    operationAuthority.expected_node_history_id === null ||
    operationAuthority.expected_image_digest === null ||
    operationAuthority.expected_image_platform === null
  ) {
    throw new AgentBackupCatalogConflictError(
      "Exact restore provider boundary requires complete target authority",
    );
  }
  if (
    !cleanupBoundary &&
    (operationAuthority.expected_image_reference === null ||
      operationAuthority.expected_image_platform_digest === null)
  ) {
    throw new AgentBackupCatalogConflictError(
      "Exact restore provider boundary requires verified image platform authority",
    );
  }

  return await dbWrite.transaction(async (tx) => {
    // Preserve the shared global order all the way to the attempt ledger:
    // organization -> backup -> operation -> lease -> sandbox -> node ->
    // occurrence -> catalogue -> replacement attempt -> primary DB clock.
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, operationAuthority.organization_id))
      .for("key share")
      .limit(1);
    if (!organization) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider organization authority is missing",
      );
    }

    const [backup] = await tx
      .select({
        catalogState: agentSandboxBackups.catalog_state,
        manifestVersion: agentSandboxBackups.manifest_version,
        canonicalManifestDraft: agentSandboxBackups.manifest_canonical_draft,
        imageDigest: agentSandboxBackups.image_digest,
      })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, operationAuthority.backup_id),
          eq(agentSandboxBackups.catalog_organization_id, operationAuthority.organization_id),
          eq(agentSandboxBackups.catalog_agent_id, operationAuthority.agent_id),
          eq(agentSandboxBackups.backup_operation_id, operationAuthority.expected_operation_id),
          eq(
            agentSandboxBackups.lifecycle_generation,
            operationAuthority.expected_activation_generation,
          ),
          eq(
            agentSandboxBackups.lifecycle_revision,
            operationAuthority.expected_lifecycle_revision,
          ),
          eq(agentSandboxBackups.manifest_digest, operationAuthority.expected_manifest_sha256),
        ),
      )
      .for("update")
      .limit(1);
    if (!backup) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider source authority is missing",
      );
    }
    if (
      !cleanupBoundary &&
      (!hasAgentBackupRestoreAuthority(backup.catalogState) ||
        backup.manifestVersion !== 3 ||
        !backup.canonicalManifestDraft ||
        backup.imageDigest !== operationAuthority.expected_image_digest)
    ) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider source lost manifest-v3 image authority",
      );
    }
    if (!cleanupBoundary) {
      const { manifest } = await parseAgentBackupManifestV3Authority({
        canonicalManifestDraft: backup.canonicalManifestDraft!,
        expectedManifestSha256: operationAuthority.expected_manifest_sha256,
      });
      if (
        manifest.operationId !== operationAuthority.expected_operation_id ||
        manifest.identity.organizationId !== operationAuthority.organization_id ||
        manifest.identity.agentId !== operationAuthority.agent_id ||
        manifest.identity.activationGeneration !==
          operationAuthority.expected_activation_generation ||
        manifest.identity.lifecycleRevision !==
          operationAuthority.expected_lifecycle_revision.toString() ||
        manifest.runtime.imageDigest !== operationAuthority.expected_image_digest
      ) {
        throw new AgentBackupCatalogConflictError(
          "Exact restore provider manifest authority diverged from its operation",
        );
      }
    }

    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, operationId))
      .for("update")
      .limit(1);
    if (
      !operation ||
      !immutableOperationAuthorityMatches(operation, operationAuthority) ||
      operation.expected_node_record_id !== operationAuthority.expected_node_record_id ||
      operation.expected_node_incarnation !== operationAuthority.expected_node_incarnation ||
      operation.expected_node_history_id !== operationAuthority.expected_node_history_id ||
      operation.expected_image_digest !== operationAuthority.expected_image_digest ||
      operation.expected_image_platform !== operationAuthority.expected_image_platform ||
      operation.expected_image_reference !== operationAuthority.expected_image_reference ||
      operation.expected_image_platform_digest !==
        operationAuthority.expected_image_platform_digest ||
      operation.expected_container_id !== operationAuthority.expected_container_id
    ) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider operation authority changed before lock",
      );
    }
    const operationHasContainerBoundMonotonePhase =
      operation.expected_container_id !== null &&
      PHASE_ORDER.indexOf(operation.phase) >= CONTAINER_CREATED_PHASE_RANK;
    if (mode === "start" || mode === "created") {
      if (operation.phase !== "vault_seeded" || operation.expected_container_id !== null) {
        throw new AgentBackupCatalogConflictError(
          `Exact restore ${mode} requires vault_seeded pre-settlement authority`,
        );
      }
    } else if (cleanupBoundary) {
      if (
        (operation.phase !== "vault_seeded" || operation.expected_container_id !== null) &&
        (operation.phase !== "container_created" || operation.expected_container_id === null)
      ) {
        throw new AgentBackupCatalogConflictError(
          `Exact restore ${mode} requires exact unsettled or provider-settled authority`,
        );
      }
    } else if (
      (operation.phase !== "vault_seeded" || operation.expected_container_id !== null) &&
      !operationHasContainerBoundMonotonePhase
    ) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider success requires pre-settlement or exact settled authority",
      );
    }

    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, operation.lease_id),
          eq(agentBackupRestoreLeases.organization_id, operation.organization_id),
          eq(agentBackupRestoreLeases.agent_id, operation.agent_id),
          eq(agentBackupRestoreLeases.backup_id, operation.backup_id),
          eq(agentBackupRestoreLeases.restore_attempt_id, operation.restore_attempt_id),
          eq(agentBackupRestoreLeases.owner_id, operation.lease_owner_id),
          eq(agentBackupRestoreLeases.generation, operation.lease_generation),
          eq(agentBackupRestoreLeases.catalog_epoch, operation.catalog_epoch),
          eq(agentBackupRestoreLeases.copy_role, operation.copy_role),
          eq(agentBackupRestoreLeases.operation_id, operation.expected_operation_id),
          eq(
            agentBackupRestoreLeases.activation_generation,
            operation.expected_activation_generation,
          ),
          eq(agentBackupRestoreLeases.lifecycle_revision, operation.expected_lifecycle_revision),
          eq(agentBackupRestoreLeases.expected_manifest_sha256, operation.expected_manifest_sha256),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) {
      throw new AgentBackupCatalogConflictError("Exact restore provider lease fence was lost");
    }

    const [sandbox] = await tx
      .select()
      .from(agentSandboxes)
      .where(
        cleanupBoundary
          ? and(
              eq(agentSandboxes.id, operation.agent_id),
              eq(agentSandboxes.organization_id, operation.organization_id),
            )
          : and(
              eq(agentSandboxes.id, operation.agent_id),
              eq(agentSandboxes.organization_id, operation.organization_id),
              isNull(agentSandboxes.deleted_at),
            ),
      )
      .for("update")
      .limit(1);
    if (!sandbox) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider sandbox authority is missing or deleted",
      );
    }

    const [node] = await tx
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, operation.expected_node_record_id!))
      .for("update")
      .limit(1);
    if (
      !node ||
      node.node_incarnation !== operation.expected_node_incarnation ||
      node.current_node_history_id !== operation.expected_node_history_id ||
      !node.node_id ||
      !node.host_key_fingerprint
    ) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider target node occurrence changed",
      );
    }
    await proveExactAgentNodeOccurrenceForLockedNode(
      tx,
      node,
      operation.expected_node_incarnation!,
      operation.expected_node_history_id!,
    );
    if (
      !cleanupBoundary &&
      requireNodeExactImagePlatform(node.metadata) !== operation.expected_image_platform
    ) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider target platform differs from reserved authority",
      );
    }

    const catalogAuthority = await lockAgentBackupCatalogAuthority(
      tx,
      operation.organization_id,
      operation.agent_id,
    );
    if (!cleanupBoundary && catalogAuthority.catalog_revision !== operation.catalog_epoch) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider authority was invalidated by a catalogue revision",
      );
    }

    const [attempt] = await tx
      .select()
      .from(agentSandboxReplacementAttempts)
      .where(
        and(
          eq(agentSandboxReplacementAttempts.id, replacementAttemptId),
          eq(agentSandboxReplacementAttempts.organization_id, operation.organization_id),
          eq(agentSandboxReplacementAttempts.agent_id, operation.agent_id),
        ),
      )
      .for("update")
      .limit(1);
    if (!attempt) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider replacement attempt is missing",
      );
    }

    const persistedLocator = exactRestoreLocatorFromAttempt(attempt);
    const cleanupRetainsProviderSuccess = cleanupBoundary
      ? exactRestoreCleanupRetainsProviderSuccess(attempt)
      : false;
    if (cleanupBoundary) {
      assertExactRestoreCleanupOperationShape(
        operation,
        persistedLocator,
        cleanupRetainsProviderSuccess,
        attempt.state === "cleanup_proven",
      );
    }

    const databaseNow = await readPostLockDatabaseNow(tx);
    const settledSuccessReplay =
      mode === "succeed" &&
      operationHasContainerBoundMonotonePhase &&
      (attempt.state === "provider_succeeded" || attempt.state === "lifecycle_committed");
    const lateSettledSuccessReplay =
      settledSuccessReplay && operation.phase !== "container_created";
    const terminalCleanupReplay = cleanupBoundary && attempt.state === "cleanup_proven";
    const requiresLiveClaim = !settledSuccessReplay && !terminalCleanupReplay;
    const requiresLiveLease =
      !settledSuccessReplay && (mode === "start" || mode === "created" || mode === "succeed");
    if (requiresLiveLease && (lease.released_at !== null || lease.expires_at <= databaseNow)) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider lease is expired or released",
      );
    }
    if (
      requiresLiveClaim &&
      (operation.lease_owner_id !== ownerId ||
        operation.claim_owner !== ownerId ||
        operation.claim_generation !== claimGeneration ||
        operation.claim_expires_at === null ||
        operation.claim_expires_at <= databaseNow)
    ) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider operation claim is not live",
      );
    }
    if (
      !finishCleanup &&
      !terminalCleanupReplay &&
      !settledSuccessReplay &&
      node.allocated_count < 1
    ) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider target has no retained allocation",
      );
    }
    if (
      mode === "start" &&
      (!node.enabled ||
        node.status !== "healthy" ||
        node.placement_state !== PLACEABLE_NODE_STATE ||
        node.metadata.capacityProvisional === true)
    ) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider target is no longer eligible for first placement",
      );
    }

    const expectedContainerName = exactRestoreContainerName(
      operation.agent_id,
      operation.restore_attempt_id,
    );
    const locator = mode === "begin_cleanup" ? persistedLocator : suppliedLocator!;
    const containerShapeMatches =
      mode === "start"
        ? locator.containerId === null
        : mode === "created"
          ? typeof locator.containerId === "string" && /^[0-9a-f]{64}$/.test(locator.containerId)
          : mode === "succeed"
            ? typeof locator.containerId === "string" &&
              /^[0-9a-f]{64}$/.test(locator.containerId) &&
              (operation.expected_container_id === null ||
                locator.containerId === operation.expected_container_id)
            : locator.containerId === persistedLocator.containerId;
    if (
      locator.sandboxId !== expectedContainerName ||
      locator.containerName !== expectedContainerName ||
      locator.nodeRecordId !== node.id ||
      locator.nodeId !== node.node_id ||
      locator.nodeIncarnation !== operation.expected_node_incarnation ||
      locator.nodeHistoryId !== operation.expected_node_history_id ||
      locator.nodeHostname !== node.hostname ||
      locator.nodeSshPort !== node.ssh_port ||
      locator.nodeSshUser !== node.ssh_user ||
      locator.nodeHostKeyFingerprint !== node.host_key_fingerprint ||
      locator.replacementSecretCleanupVersion !== 1 ||
      locator.allocationCounted !== true ||
      locator.vpnNodeName !== null ||
      locator.vpnRegistrationStartedAt !== null ||
      locator.previousVpnNodeId !== null ||
      locator.vpnNodeId !== null ||
      !containerShapeMatches
    ) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider locator differs from locked node authority",
      );
    }

    const tokenSha256 =
      cleanupBoundary || lateSettledSuccessReplay
        ? null
        : requireSha256(sandbox.activation_token_hash ?? "", "sandbox.activationTokenSha256");
    const tokenCiphertext =
      cleanupBoundary || lateSettledSuccessReplay
        ? null
        : requireActivationTokenCiphertext(sandbox.activation_token_ciphertext ?? "");
    if (!cleanupBoundary && !lateSettledSuccessReplay) {
      verifyAgentBackupRestoreQuarantineForLockedAuthorities({
        operation,
        sandbox,
        activationTokenSha256: tokenSha256!,
        activationTokenCiphertext: tokenCiphertext!,
        nodeId: node.node_id,
      });
    }

    const boundaryInput = {
      attemptId: replacementAttemptId,
      organizationId: operation.organization_id,
      agentId: operation.agent_id,
      lifecycleRevision: attempt.lifecycle_revision.toString(),
      activationGeneration: operation.restore_attempt_id,
      lifecycleJobId: attempt.lifecycle_job_id,
      lifecycleExecutionGeneration: attempt.lifecycle_execution_generation,
      restoreAuthority: {
        leaseId: lease.id,
        backupId: lease.backup_id,
        restoreAttemptId: lease.restore_attempt_id,
        ownerId: lease.owner_id,
        fencingToken: lease.generation,
        catalogEpoch: lease.catalog_epoch.toString(),
        copyRole: lease.copy_role,
        operationId: lease.operation_id,
        sourceActivationGeneration: lease.activation_generation,
        sourceLifecycleRevision: lease.lifecycle_revision.toString(),
        expectedManifestSha256: lease.expected_manifest_sha256,
        expiresAt: new Date(
          (cleanupBoundary
            ? (attempt.restore_lease_expires_at ?? lease.expires_at)
            : lease.expires_at
          ).getTime(),
        ),
      },
      locator,
      databaseNow,
    } as const;
    let recorded;
    let operationForResult: AgentBackupRestoreOperation = operation;
    if (mode === "start") {
      recorded = await markAgentSandboxExactRestoreProviderStartedForLockedAuthoritiesInTransaction(
        tx,
        boundaryInput,
      );
    } else if (mode === "created") {
      recorded = await recordAgentSandboxReplacementCreatedInTransaction(
        tx,
        {
          attemptId: replacementAttemptId,
          organizationId: operation.organization_id,
          agentId: operation.agent_id,
        },
        locator,
      );
    } else if (mode === "succeed") {
      recorded =
        await recordAgentSandboxExactRestoreProviderSucceededForLockedAuthoritiesInTransaction(tx, {
          ...boundaryInput,
          receiptDigest: receiptDigest!,
        });
      if (lateSettledSuccessReplay) {
        if (!recorded.replayed) {
          throw new AgentBackupCatalogConflictError(
            "Advanced exact restore cannot first-settle a provider response",
          );
        }
      } else {
        const composed =
          await recordAgentBackupRestoreQuarantinedContainerForLockedAuthoritiesInTransaction(tx, {
            operation,
            sandbox,
            ownerId: ownerId!,
            claimGeneration: claimGeneration!,
            containerId: locator.containerId!,
            activationTokenSha256: tokenSha256!,
            activationTokenCiphertext: tokenCiphertext!,
            nodeId: node.node_id,
            databaseNow,
          });
        if (composed.replayed !== recorded.replayed) {
          throw new AgentBackupCatalogConflictError(
            "Exact restore provider settlement ledgers disagree on replay classification",
          );
        }
        operationForResult = composed.operation;
      }
    } else if (mode === "begin_cleanup") {
      recorded = await beginAgentSandboxExactRestoreCleanupForLockedAuthoritiesInTransaction(
        tx,
        boundaryInput,
      );
    } else {
      recorded = await finishAgentSandboxExactRestoreCleanupForLockedAuthoritiesInTransaction(tx, {
        ...boundaryInput,
        receiptDigest: receiptDigest!,
      });
      if (!recorded.replayed) {
        if (cleanupRetainsProviderSuccess) {
          const rearmed =
            await rearmAgentBackupRestoreQuarantineAfterExactProviderCleanupForLockedAuthoritiesInTransaction(
              tx,
              {
                operation,
                sandbox,
                ownerId,
                claimGeneration,
                containerId: locator.containerId!,
                nodeId: locator.nodeId,
                databaseNow,
              },
            );
          operationForResult = rearmed.operation;
        } else {
          const [claimConsumed] = await tx
            .update(agentBackupRestoreOperations)
            .set({
              claim_owner: null,
              claim_generation: null,
              claim_expires_at: null,
              updated_at: databaseNow,
            })
            .where(
              and(
                eq(agentBackupRestoreOperations.id, operation.id),
                eq(agentBackupRestoreOperations.phase, "vault_seeded"),
                isNull(agentBackupRestoreOperations.expected_container_id),
                eq(agentBackupRestoreOperations.claim_owner, ownerId),
                eq(agentBackupRestoreOperations.claim_generation, claimGeneration),
                gt(agentBackupRestoreOperations.claim_expires_at, databaseNow),
              ),
            )
            .returning();
          if (!claimConsumed) {
            throw new AgentBackupCatalogConflictError(
              "Exact restore cleanup finish lost its claim-consumption CAS",
            );
          }
          operationForResult = claimConsumed;
        }

        const [releasedCapacity] = await tx
          .update(dockerNodes)
          .set({
            allocated_count: sql`${dockerNodes.allocated_count} - 1`,
            updated_at: databaseNow,
          })
          .where(
            and(
              eq(dockerNodes.id, node.id),
              eq(dockerNodes.node_id, locator.nodeId),
              eq(dockerNodes.node_incarnation, locator.nodeIncarnation),
              eq(dockerNodes.current_node_history_id, locator.nodeHistoryId),
              gt(dockerNodes.allocated_count, 0),
            ),
          )
          .returning({ id: dockerNodes.id });
        if (!releasedCapacity) {
          throw new AgentBackupCatalogConflictError(
            "Exact restore cleanup capacity release lost its occurrence CAS",
          );
        }
      }
    }

    // The attempt lock may have contended. A fresh DB clock ensures that wait
    // cannot admit a first provider call or settlement under an expired claim.
    const afterAttemptDatabaseNow = await readPostLockDatabaseNow(tx);
    if (
      (requiresLiveLease && lease.expires_at <= afterAttemptDatabaseNow) ||
      (requiresLiveClaim && operation.claim_expires_at! <= afterAttemptDatabaseNow)
    ) {
      throw new AgentBackupCatalogConflictError(
        "Exact restore provider authority expired while locking its attempt",
      );
    }
    return Object.freeze({
      operation: Object.freeze(operationForResult),
      attempt: recorded.attempt,
      locator: exactRestoreLocatorFromAttempt(recorded.attempt),
      replayed: recorded.replayed,
    });
  });
}

/**
 * Final pre-SSH CAS for exact restore create. Only `replayed: false` authorizes
 * the caller to invoke the provider; a replay means the remote effect may have
 * started and must be reconciled instead of repeated.
 */
export async function markAgentSandboxExactRestoreProviderStarted(
  input: AgentSandboxExactRestoreProviderBoundaryInput,
): Promise<AgentSandboxExactRestoreProviderBoundaryResult> {
  return await runAgentSandboxExactRestoreProviderBoundary(input, "start");
}

/** Persist the provider-returned Docker ID without advancing quarantine or consuming the claim. */
export async function recordAgentSandboxExactRestoreProviderCreated(
  input: AgentSandboxExactRestoreProviderBoundaryInput,
): Promise<AgentSandboxExactRestoreProviderBoundaryResult> {
  return await runAgentSandboxExactRestoreProviderBoundary(input, "created");
}

/**
 * Retain the deterministic provider receipt under a freshly claimed
 * container-created restore and its byte-identical persisted SSH locator.
 */
export async function recordAgentSandboxExactRestoreProviderSucceeded(
  input: RecordAgentSandboxExactRestoreProviderSucceededInput,
): Promise<AgentSandboxExactRestoreProviderBoundaryResult> {
  const receiptDigest = requireSha256(input.receiptDigest, "receiptDigest");
  return await runAgentSandboxExactRestoreProviderBoundary(input, "succeed", receiptDigest);
}

/**
 * Fence late provider callbacks while retaining the dedicated live cleanup
 * claim across the remote effect. The locator is loaded from the locked
 * attempt rather than accepted from runtime input.
 */
export async function beginAgentSandboxExactRestoreCleanup(
  input: BeginAgentSandboxExactRestoreCleanupInput,
): Promise<AgentSandboxExactRestoreProviderBoundaryResult> {
  return await runAgentSandboxExactRestoreProviderBoundary(input, "begin_cleanup");
}

/**
 * Retain remote cleanup proof and release the exact occurrence allocation once.
 * Lease expiry/release and catalogue-state advancement cannot strand capacity.
 */
export async function finishAgentSandboxExactRestoreCleanup(
  input: FinishAgentSandboxExactRestoreCleanupInput,
): Promise<AgentSandboxExactRestoreProviderBoundaryResult> {
  const cleanupReceiptDigest = requireSha256(input.cleanupReceiptDigest, "cleanupReceiptDigest");
  return await runAgentSandboxExactRestoreProviderBoundary(
    input,
    "finish_cleanup",
    cleanupReceiptDigest,
  );
}

/**
 * Reserve one caller-selected, already-attested Docker target before any remote
 * restore effect. This repository never discovers, autoscales, or reselects a
 * node: the exact record/incarnation/occurrence tuple is the request authority.
 *
 * Capacity and the operation target commit in the same transaction. A lost
 * response can therefore replay the exact tuple without consuming a second
 * slot, while any different tuple is an explicit conflict.
 *
 * Definition-only integration guard: no production caller may use this until
 * shared workload reconciliation counts restore ownership and its
 * settlement/release path. The API-boundary test enforces that handoff.
 */
export async function reserveAgentBackupRestoreTarget(params: {
  operationId: string;
  ownerId: string;
  claimGeneration: string;
  targetNodeRecordId: string;
  targetNodeIncarnation: string;
  targetNodeHistoryId: string;
}): Promise<ReserveAgentBackupRestoreTargetResult> {
  const operationId = requireUuid(params.operationId, "operationId");
  const claimGeneration = requireUuid(params.claimGeneration, "claimGeneration");
  const targetNodeRecordId = requireUuid(params.targetNodeRecordId, "targetNodeRecordId");
  const targetNodeIncarnation = requireUuid(params.targetNodeIncarnation, "targetNodeIncarnation");
  const targetNodeHistoryId = requireUuid(params.targetNodeHistoryId, "targetNodeHistoryId");
  requireOwnerId(params.ownerId);

  // This first read supplies immutable keys for the global lock order. The row
  // is locked and compared again below before any capacity or target write.
  const [operationAuthority] = await dbWrite
    .select()
    .from(agentBackupRestoreOperations)
    .where(eq(agentBackupRestoreOperations.id, operationId))
    .limit(1);
  if (!operationAuthority) {
    throw new AgentBackupCatalogConflictError("Restore operation is missing");
  }

  return await dbWrite.transaction(async (tx) => {
    // Multi-authority restore work uses backup -> operation -> lease -> node ->
    // catalogue. The operation lock comes before the lease so an ordinary
    // claimant (operation -> lease) can finish without an AB-BA cycle.
    const [backup] = await tx
      .select({
        catalogState: agentSandboxBackups.catalog_state,
        manifestVersion: agentSandboxBackups.manifest_version,
        canonicalManifestDraft: agentSandboxBackups.manifest_canonical_draft,
        imageDigest: agentSandboxBackups.image_digest,
      })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, operationAuthority.backup_id),
          eq(agentSandboxBackups.catalog_organization_id, operationAuthority.organization_id),
          eq(agentSandboxBackups.catalog_agent_id, operationAuthority.agent_id),
          eq(agentSandboxBackups.backup_operation_id, operationAuthority.expected_operation_id),
          eq(
            agentSandboxBackups.lifecycle_generation,
            operationAuthority.expected_activation_generation,
          ),
          eq(
            agentSandboxBackups.lifecycle_revision,
            operationAuthority.expected_lifecycle_revision,
          ),
          eq(agentSandboxBackups.manifest_digest, operationAuthority.expected_manifest_sha256),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !backup ||
      !hasAgentBackupRestoreAuthority(backup.catalogState) ||
      backup.manifestVersion !== 3 ||
      !backup.canonicalManifestDraft ||
      !backup.imageDigest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore target source is absent, non-restorable, or lacks manifest-v3 authority",
      );
    }
    const parsedManifest = await parseAgentBackupManifestV3Authority({
      canonicalManifestDraft: backup.canonicalManifestDraft,
      expectedManifestSha256: operationAuthority.expected_manifest_sha256,
    });
    const manifest = parsedManifest.manifest;
    if (
      manifest.operationId !== operationAuthority.expected_operation_id ||
      manifest.identity.organizationId !== operationAuthority.organization_id ||
      manifest.identity.agentId !== operationAuthority.agent_id ||
      manifest.identity.activationGeneration !==
        operationAuthority.expected_activation_generation ||
      manifest.identity.lifecycleRevision !==
        operationAuthority.expected_lifecycle_revision.toString() ||
      manifest.runtime.imageDigest !== backup.imageDigest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore target image differs from its exact manifest-v3 authority",
      );
    }

    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, operationId))
      .for("update")
      .limit(1);
    if (!operation) {
      throw new AgentBackupCatalogConflictError("Restore operation is missing");
    }
    if (
      operation.organization_id !== operationAuthority.organization_id ||
      operation.agent_id !== operationAuthority.agent_id ||
      operation.backup_id !== operationAuthority.backup_id ||
      operation.restore_attempt_id !== operationAuthority.restore_attempt_id ||
      operation.lease_id !== operationAuthority.lease_id ||
      operation.lease_generation !== operationAuthority.lease_generation ||
      operation.lease_owner_id !== operationAuthority.lease_owner_id ||
      operation.catalog_epoch !== operationAuthority.catalog_epoch ||
      operation.copy_role !== operationAuthority.copy_role ||
      operation.expected_operation_id !== operationAuthority.expected_operation_id ||
      operation.expected_manifest_sha256 !== operationAuthority.expected_manifest_sha256 ||
      operation.expected_activation_generation !==
        operationAuthority.expected_activation_generation ||
      operation.expected_lifecycle_revision !== operationAuthority.expected_lifecycle_revision
    ) {
      throw new AgentBackupCatalogConflictError("Restore operation authority changed before lock");
    }
    if (
      operation.phase !== "reserved" &&
      !(operation.phase === "failed_retryable" && operation.resume_phase === "reserved")
    ) {
      throw new AgentBackupCatalogConflictError(
        `Restore target cannot be reserved while operation is in ${operation.phase}`,
      );
    }

    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, operation.lease_id),
          eq(agentBackupRestoreLeases.organization_id, operation.organization_id),
          eq(agentBackupRestoreLeases.agent_id, operation.agent_id),
          eq(agentBackupRestoreLeases.backup_id, operation.backup_id),
          eq(agentBackupRestoreLeases.operation_id, operation.expected_operation_id),
          eq(
            agentBackupRestoreLeases.activation_generation,
            operation.expected_activation_generation,
          ),
          eq(agentBackupRestoreLeases.lifecycle_revision, operation.expected_lifecycle_revision),
          eq(agentBackupRestoreLeases.expected_manifest_sha256, operation.expected_manifest_sha256),
          eq(agentBackupRestoreLeases.copy_role, operation.copy_role),
          eq(agentBackupRestoreLeases.restore_attempt_id, operation.restore_attempt_id),
          eq(agentBackupRestoreLeases.owner_id, operation.lease_owner_id),
          eq(agentBackupRestoreLeases.generation, operation.lease_generation),
          eq(agentBackupRestoreLeases.catalog_epoch, operation.catalog_epoch),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) {
      throw new AgentBackupCatalogConflictError("Restore lease fence was lost");
    }

    const [node] = await tx
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, targetNodeRecordId))
      .for("update")
      .limit(1);
    if (!node) {
      throw new AgentBackupCatalogConflictError("Restore target node is missing");
    }
    if (node.node_incarnation !== targetNodeIncarnation) {
      throw new AgentBackupCatalogConflictError("Restore target node incarnation changed");
    }
    if (node.current_node_history_id !== targetNodeHistoryId) {
      throw new AgentBackupCatalogConflictError("Restore target node occurrence changed");
    }
    await proveExactAgentNodeOccurrenceForLockedNode(
      tx,
      node,
      targetNodeIncarnation,
      targetNodeHistoryId,
    );
    const targetPlatform = requireNodeExactImagePlatform(node.metadata);

    const catalogAuthority = await lockAgentBackupCatalogAuthority(
      tx,
      operation.organization_id,
      operation.agent_id,
    );
    if (catalogAuthority.catalog_revision !== operation.catalog_epoch) {
      throw new AgentBackupCatalogConflictError(
        "Restore target authority was invalidated by a catalogue revision",
      );
    }

    // The node or catalogue lock can wait behind another authority writer.
    // Re-read the primary DB clock only after every authority lock so no
    // expired claim/lease commits.
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at <= databaseNow) {
      throw new AgentBackupCatalogConflictError("Restore lease is expired or released");
    }
    if (
      operation.claim_owner !== params.ownerId ||
      operation.claim_generation !== claimGeneration ||
      operation.claim_expires_at === null ||
      operation.claim_expires_at <= databaseNow
    ) {
      throw new AgentBackupCatalogConflictError("Restore operation claim is not live");
    }

    const target = Object.freeze({
      nodeRecordId: node.id,
      nodeId: node.node_id,
      nodeIncarnation: targetNodeIncarnation,
      nodeHistoryId: targetNodeHistoryId,
      imageDigest: manifest.runtime.imageDigest,
      platform: targetPlatform,
      imageReference: operation.expected_image_reference,
      imagePlatformDigest: operation.expected_image_platform_digest,
    });
    const targetAlreadyRecorded = operation.expected_node_record_id !== null;
    if (targetAlreadyRecorded) {
      if (
        operation.expected_node_record_id !== target.nodeRecordId ||
        operation.expected_node_incarnation !== target.nodeIncarnation ||
        operation.expected_node_history_id !== target.nodeHistoryId ||
        operation.expected_image_digest !== target.imageDigest ||
        operation.expected_image_platform !== target.platform
      ) {
        throw new AgentBackupCatalogConflictError("Restore target replay authority mismatch");
      }
      return { operation: Object.freeze(operation), target, replayed: true };
    }
    if (
      operation.expected_node_incarnation !== null ||
      operation.expected_node_history_id !== null ||
      operation.expected_image_digest !== null ||
      operation.expected_image_platform !== null ||
      operation.expected_image_reference !== null ||
      operation.expected_image_platform_digest !== null
    ) {
      throw new AgentBackupCatalogConflictError("Restore target authority is only partially set");
    }
    if (
      !node.enabled ||
      node.status !== "healthy" ||
      node.placement_state !== PLACEABLE_NODE_STATE ||
      node.metadata.capacityProvisional === true
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore target is not an enabled, healthy, open existing node",
      );
    }
    if (node.allocated_count >= node.capacity) {
      throw new AgentBackupCatalogConflictError("Restore target has no existing capacity");
    }

    const [reservedNode] = await tx
      .update(dockerNodes)
      .set({
        allocated_count: sql`${dockerNodes.allocated_count} + 1`,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(dockerNodes.id, targetNodeRecordId),
          eq(dockerNodes.node_incarnation, targetNodeIncarnation),
          eq(dockerNodes.current_node_history_id, targetNodeHistoryId),
          eq(dockerNodes.enabled, true),
          eq(dockerNodes.status, "healthy"),
          eq(dockerNodes.placement_state, PLACEABLE_NODE_STATE),
          sql`COALESCE(${dockerNodes.metadata}->>'capacityProvisional', 'false') <> 'true'`,
          sql`${dockerNodes.allocated_count} < ${dockerNodes.capacity}`,
        ),
      )
      .returning({ id: dockerNodes.id });
    if (!reservedNode) {
      throw new AgentBackupCatalogConflictError("Restore target capacity reservation lost its CAS");
    }

    const [reservedOperation] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        expected_node_record_id: target.nodeRecordId,
        expected_node_incarnation: target.nodeIncarnation,
        expected_node_history_id: target.nodeHistoryId,
        expected_image_digest: target.imageDigest,
        expected_image_platform: target.platform,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operationId),
          eq(agentBackupRestoreOperations.phase, operation.phase),
          eq(agentBackupRestoreOperations.claim_generation, claimGeneration),
          sql`${agentBackupRestoreOperations.expected_node_record_id} IS NULL`,
          sql`${agentBackupRestoreOperations.expected_node_incarnation} IS NULL`,
          sql`${agentBackupRestoreOperations.expected_node_history_id} IS NULL`,
          sql`${agentBackupRestoreOperations.expected_image_digest} IS NULL`,
          sql`${agentBackupRestoreOperations.expected_image_platform} IS NULL`,
          sql`${agentBackupRestoreOperations.expected_image_reference} IS NULL`,
          sql`${agentBackupRestoreOperations.expected_image_platform_digest} IS NULL`,
        ),
      )
      .returning();
    if (!reservedOperation) {
      throw new AgentBackupCatalogConflictError("Restore target reservation lost its CAS");
    }
    return { operation: Object.freeze(reservedOperation), target, replayed: false };
  });
}

/**
 * Advance one generic phase under a live claim. First container binding is
 * excluded: its dedicated quarantine writer must update the sandbox ledger and
 * operation in one transaction. A retry may re-enter an already-bound
 * `container_created` phase without rewriting that identity. Finalization still
 * records its receipt in the same statement as the phase transition.
 */
export async function advanceAgentBackupRestoreOperation(params: {
  operationId: string;
  ownerId: string;
  claimGeneration: string;
  fromPhase: AgentBackupRestorePhase;
  toPhase: AgentBackupRestorePhase;
  receiptDigest?: string;
}): Promise<Readonly<AgentBackupRestoreOperation>> {
  const operationId = requireUuid(params.operationId, "operationId");
  const claimGeneration = requireUuid(params.claimGeneration, "claimGeneration");
  const toRank = PHASE_ORDER.indexOf(params.toPhase);
  // Resuming re-enters the recorded phase; otherwise a phase advances to exactly
  // its successor. Skipping would let a coordinator bug finalize a restore that
  // never created a container or streamed a byte.
  const resuming = params.fromPhase === "failed_retryable";
  if (!resuming) {
    const fromRank = PHASE_ORDER.indexOf(params.fromPhase);
    if (fromRank < 0 || toRank !== fromRank + 1) {
      throw new AgentBackupCatalogConflictError(
        `Restore operation cannot advance from ${params.fromPhase} to ${params.toPhase}`,
      );
    }
  } else if (toRank < 0) {
    throw new AgentBackupCatalogConflictError(`${params.toPhase} is not a resumable phase`);
  }
  // Fail closed for structurally typed or JavaScript callers still sending the
  // retired generic identity bag before classifying any requested phase.
  if ("recordedIdentity" in params) {
    throw new AgentBackupCatalogConflictError(
      "Generic restore advance cannot record a container identity",
    );
  }
  if (params.toPhase === "vault_seeded") {
    throw new AgentBackupCatalogConflictError(
      "Restore vault seeding must be recorded through vault-seed receipt authority",
    );
  }
  const resumingRecordedContainer = resuming && params.toPhase === "container_created";
  if (params.toPhase === "container_created" && !resumingRecordedContainer) {
    throw new AgentBackupCatalogConflictError(
      "Restore container creation must be recorded through quarantine authority",
    );
  }
  if (params.receiptDigest !== undefined) requireSha256(params.receiptDigest, "receiptDigest");
  if ((params.toPhase === "finalized") !== (params.receiptDigest !== undefined)) {
    throw new AgentBackupCatalogConflictError(
      "Finalization requires a receipt digest and no other phase accepts one",
    );
  }

  return await dbWrite.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, operationId))
      .for("update")
      .limit(1);
    if (!operation) {
      throw new AgentBackupCatalogConflictError("Restore operation is missing");
    }

    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, operation.lease_id),
          eq(agentBackupRestoreLeases.organization_id, operation.organization_id),
          eq(agentBackupRestoreLeases.generation, operation.lease_generation),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) {
      throw new AgentBackupCatalogConflictError("Restore lease fence was lost");
    }

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at <= databaseNow) {
      throw new AgentBackupCatalogConflictError("Restore lease is expired or released");
    }
    if (
      operation.claim_owner !== params.ownerId ||
      operation.claim_generation !== claimGeneration ||
      operation.claim_expires_at === null ||
      operation.claim_expires_at <= databaseNow
    ) {
      throw new AgentBackupCatalogConflictError("Restore operation claim is not live");
    }

    const targetAuthorityRequired = params.toPhase !== "reserved";
    if (
      targetAuthorityRequired &&
      (operation.expected_node_record_id === null ||
        operation.expected_node_incarnation === null ||
        operation.expected_node_history_id === null ||
        operation.expected_image_digest === null)
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore operation cannot leave target reservation without complete target authority",
      );
    }

    if (resuming && operation.resume_phase !== params.toPhase) {
      throw new AgentBackupCatalogConflictError(
        `Restore operation must resume ${operation.resume_phase}, not ${params.toPhase}`,
      );
    }
    if (resumingRecordedContainer && operation.expected_container_id === null) {
      throw new AgentBackupCatalogConflictError(
        "Restore operation cannot resume container_created without a recorded container identity",
      );
    }

    const [advanced] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        phase: params.toPhase,
        resume_phase: null,
        claim_owner: null,
        claim_generation: null,
        claim_expires_at: null,
        ...(params.receiptDigest !== undefined
          ? { receipt_digest: params.receiptDigest, completed_at: databaseNow }
          : {}),
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operationId),
          eq(agentBackupRestoreOperations.phase, params.fromPhase),
          eq(agentBackupRestoreOperations.claim_generation, claimGeneration),
          targetAuthorityRequired
            ? and(
                isNotNull(agentBackupRestoreOperations.expected_node_record_id),
                isNotNull(agentBackupRestoreOperations.expected_node_incarnation),
                isNotNull(agentBackupRestoreOperations.expected_node_history_id),
                isNotNull(agentBackupRestoreOperations.expected_image_digest),
              )
            : undefined,
          resumingRecordedContainer
            ? isNotNull(agentBackupRestoreOperations.expected_container_id)
            : undefined,
        ),
      )
      .returning();
    if (!advanced) {
      throw new AgentBackupCatalogConflictError("Restore operation advance lost its CAS");
    }
    return Object.freeze(advanced);
  });
}

/**
 * Extend a live claim. A phase that streams a whole backup outlives any sane
 * default claim window, so the worker renews rather than losing the claim
 * mid-work and handing the operation to a second worker.
 */
export async function heartbeatAgentBackupRestoreOperation(params: {
  operationId: string;
  ownerId: string;
  claimGeneration: string;
  claimMs: number;
}): Promise<Readonly<AgentBackupRestoreOperation>> {
  const operationId = requireUuid(params.operationId, "operationId");
  const claimGeneration = requireUuid(params.claimGeneration, "claimGeneration");
  requireOwnerId(params.ownerId);
  if (
    !Number.isSafeInteger(params.claimMs) ||
    params.claimMs < MIN_CLAIM_MS ||
    params.claimMs > MAX_CLAIM_MS
  ) {
    throw new AgentBackupCatalogConflictError(
      `claimMs must be an integer between ${MIN_CLAIM_MS} and ${MAX_CLAIM_MS}`,
    );
  }

  return await dbWrite.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, operationId))
      .for("update")
      .limit(1);
    if (!operation) {
      throw new AgentBackupCatalogConflictError("Restore operation is missing");
    }

    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, operation.lease_id),
          eq(agentBackupRestoreLeases.organization_id, operation.organization_id),
          eq(agentBackupRestoreLeases.generation, operation.lease_generation),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) {
      throw new AgentBackupCatalogConflictError("Restore lease fence was lost");
    }

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at <= databaseNow) {
      throw new AgentBackupCatalogConflictError("Restore lease is expired or released");
    }
    if (
      operation.claim_owner !== params.ownerId ||
      operation.claim_generation !== claimGeneration ||
      operation.claim_expires_at === null ||
      operation.claim_expires_at <= databaseNow
    ) {
      throw new AgentBackupCatalogConflictError("Restore operation claim is not live");
    }

    const [renewed] = await tx
      .update(agentBackupRestoreOperations)
      .set({ claim_expires_at: new Date(databaseNow.getTime() + params.claimMs) })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operationId),
          eq(agentBackupRestoreOperations.claim_generation, claimGeneration),
        ),
      )
      .returning();
    if (!renewed) {
      throw new AgentBackupCatalogConflictError("Restore operation heartbeat lost its CAS");
    }
    return Object.freeze(renewed);
  });
}

/**
 * Record a failure under a live claim. A retryable failure pins the phase to
 * re-enter — which must be the phase the operation is actually in, or the guard
 * would turn a caller's mistake into an enforced skip. A terminal one closes it.
 */
export async function failAgentBackupRestoreOperation(params: {
  operationId: string;
  ownerId: string;
  claimGeneration: string;
  retryable: boolean;
  resumePhase: AgentBackupRestorePhase;
  errorCode: string;
  error: string;
  failureDigest: string;
  retryDelayMs: number;
}): Promise<Readonly<AgentBackupRestoreOperation>> {
  const operationId = requireUuid(params.operationId, "operationId");
  const claimGeneration = requireUuid(params.claimGeneration, "claimGeneration");
  requireOwnerId(params.ownerId);
  requireSha256(params.failureDigest, "failureDigest");
  requireBoundedIdentity(params.errorCode, "errorCode");
  if (params.retryable && !PHASE_ORDER.includes(params.resumePhase)) {
    throw new AgentBackupCatalogConflictError(`${params.resumePhase} is not a resumable phase`);
  }
  if (
    !Number.isSafeInteger(params.retryDelayMs) ||
    params.retryDelayMs < 0 ||
    params.retryDelayMs > MAX_RETRY_DELAY_MS
  ) {
    throw new AgentBackupCatalogConflictError(
      `retryDelayMs must be an integer between 0 and ${MAX_RETRY_DELAY_MS}`,
    );
  }

  return await dbWrite.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, operationId))
      .for("update")
      .limit(1);
    if (!operation) {
      throw new AgentBackupCatalogConflictError("Restore operation is missing");
    }
    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, operation.lease_id),
          eq(agentBackupRestoreLeases.organization_id, operation.organization_id),
          eq(agentBackupRestoreLeases.generation, operation.lease_generation),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) {
      throw new AgentBackupCatalogConflictError("Restore lease fence was lost");
    }

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at <= databaseNow) {
      throw new AgentBackupCatalogConflictError("Restore lease is expired or released");
    }
    if (
      operation.claim_owner !== params.ownerId ||
      operation.claim_generation !== claimGeneration ||
      operation.claim_expires_at === null ||
      operation.claim_expires_at <= databaseNow
    ) {
      throw new AgentBackupCatalogConflictError("Restore operation claim is not live");
    }
    if (params.retryable && params.resumePhase !== operation.phase) {
      throw new AgentBackupCatalogConflictError(
        `Restore operation is in ${operation.phase} and cannot pin a resume at ${params.resumePhase}`,
      );
    }

    const [failed] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        phase: params.retryable ? "failed_retryable" : "failed_terminal",
        resume_phase: params.retryable ? params.resumePhase : null,
        claim_owner: null,
        claim_generation: null,
        claim_expires_at: null,
        next_attempt_at: new Date(databaseNow.getTime() + params.retryDelayMs),
        last_error_code: params.errorCode,
        last_error: params.error,
        last_failure_generation: claimGeneration,
        last_failure_digest: params.failureDigest,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operationId),
          eq(agentBackupRestoreOperations.claim_generation, claimGeneration),
        ),
      )
      .returning();
    if (!failed) {
      throw new AgentBackupCatalogConflictError("Restore operation failure lost its CAS");
    }
    return Object.freeze(failed);
  });
}
