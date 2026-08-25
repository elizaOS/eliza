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
import { and, eq, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import {
  agentActivationEndpointEnvelopesEqual,
  hashAgentActivationEndpointEnvelope,
  parseAgentActivationEndpointAuthority,
} from "../../lib/services/agent-activation-endpoint-authority";
import { requireBoundedIdentity } from "../../lib/services/agent-backup-catalog-state";
import { isValidUUID } from "../../lib/utils/validation";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
  type AgentBackupRestoreOperation,
  type AgentBackupRestorePhase,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "../schemas/agent-backup-catalog";
import {
  type AgentActivationEndpointEnvelopeV1,
  type AgentSandbox,
  agentSandboxBackups,
  agentSandboxes,
} from "../schemas/agent-sandboxes";
import { dockerNodes, PLACEABLE_NODE_STATE } from "../schemas/docker-nodes";
import {
  AgentBackupCatalogConflictError,
  lockAgentBackupCatalogAuthority,
} from "./agent-backup-catalog";
import { parseAgentBackupManifestV3Authority } from "./agent-backup-restore";
import { hasAgentBackupRestoreAuthority } from "./agent-backup-restore-authority";
import { proveExactAgentNodeOccurrenceForLockedNode } from "./agent-backup-restore-history";
import type { AgentBackupRestoreLeaseAuthorityReceipt } from "./agent-backup-restore-lease";
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

const MIN_CLAIM_MS = 1_000;
const MAX_CLAIM_MS = 3_600_000;
const MAX_RETRY_DELAY_MS = 3_600_000;

export interface OpenAgentBackupRestoreOperationInput {
  authority: AgentBackupRestoreLeaseAuthorityReceipt;
  leaseId: string;
}

export interface AgentBackupRestoreOperationClaim {
  operation: Readonly<AgentBackupRestoreOperation>;
  claimGeneration: string;
  databaseNow: Date;
}

export interface AgentBackupRestoreTargetAuthority {
  nodeRecordId: string;
  nodeId: string;
  nodeIncarnation: string;
  nodeHistoryId: string;
  imageDigest: string;
}

export interface ReserveAgentBackupRestoreTargetResult {
  operation: Readonly<AgentBackupRestoreOperation>;
  target: Readonly<AgentBackupRestoreTargetAuthority>;
  replayed: boolean;
}

export interface ReleaseAgentBackupRestoreCapacityResult {
  operation: Readonly<AgentBackupRestoreOperation>;
  replayed: boolean;
}

export interface RecoverAgentBackupRestoreCapacityAfterCrashResult {
  operation: Readonly<AgentBackupRestoreOperation>;
  replayed: boolean;
}

const CAPACITY_CRASH_RECOVERY_ERROR_CODE = "RESTORE_CAPACITY_RECOVERED_AFTER_CRASH";
const CAPACITY_CRASH_RECOVERY_ERROR =
  "Restore capacity was released after the lease and worker claim became non-live";

function requireOwnerId(value: string): string {
  requireBoundedIdentity(value, "ownerId");
  if (Buffer.byteLength(value, "utf8") > 255) {
    throw new AgentBackupCatalogConflictError("ownerId must contain at most 255 UTF-8 bytes");
  }
  return value;
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

function hasExactRecoverableRestoreQuarantine(
  operation: Readonly<AgentBackupRestoreOperation>,
  sandbox: Readonly<AgentSandbox>,
): boolean {
  const hasCommonAuthority =
    sandbox.deleted_at === null &&
    sandbox.deletion_attempt_id === null &&
    sandbox.status !== "deletion_pending" &&
    sandbox.status !== "deletion_failed" &&
    sandbox.activation_generation === operation.restore_attempt_id &&
    sandbox.activation_lifecycle_revision !== null &&
    sandbox.activation_lifecycle_revision >= 0n &&
    sandbox.activation_lifecycle_revision <= BigInt(sandbox.lifecycle_revision) &&
    sandbox.activation_purpose === "restore" &&
    sandbox.activation_backup_id === operation.backup_id &&
    sandbox.activation_backup_hash === operation.expected_manifest_sha256 &&
    typeof sandbox.activation_token_hash === "string" &&
    /^[0-9a-f]{64}$/.test(sandbox.activation_token_hash) &&
    typeof sandbox.activation_token_ciphertext === "string" &&
    Buffer.byteLength(sandbox.activation_token_ciphertext, "utf8") >= 1 &&
    Buffer.byteLength(sandbox.activation_token_ciphertext, "utf8") <= 16_384 &&
    sandbox.activation_receipt === null &&
    sandbox.activation_receipt_hash === null &&
    sandbox.activation_authority_published_at === null &&
    sandbox.activation_funding_revision === null &&
    sandbox.activation_dispatched_at === null &&
    sandbox.activation_completed_at === null &&
    sandbox.activation_consent_lifecycle_revision === null &&
    sandbox.activation_consent_head_backup_id === null &&
    sandbox.activation_consent_head_backup_hash === null;
  if (!hasCommonAuthority) return false;

  if (sandbox.activation_phase === "container_pending") {
    return (
      operation.expected_container_id === null &&
      operation.expected_endpoint_envelope === null &&
      operation.expected_endpoint_sha256 === null &&
      sandbox.activation_container_id === null &&
      sandbox.activation_node_id === null &&
      sandbox.activation_image_digest === null &&
      sandbox.activation_boot_id === null &&
      sandbox.activation_endpoint_envelope === null &&
      sandbox.activation_endpoint_sha256 === null
    );
  }
  const operationEndpoint = parseAgentActivationEndpointAuthority(
    operation.expected_endpoint_envelope,
    operation.expected_endpoint_sha256,
    operation.restore_attempt_id,
  );
  const sandboxEndpoint = parseAgentActivationEndpointAuthority(
    sandbox.activation_endpoint_envelope,
    sandbox.activation_endpoint_sha256,
    operation.restore_attempt_id,
  );
  return (
    sandbox.activation_phase === "restore_pending" &&
    operation.expected_container_id !== null &&
    operationEndpoint !== null &&
    sandboxEndpoint !== null &&
    sandbox.character_id !== null &&
    operationEndpoint.runtimeAgentId === sandbox.character_id &&
    sandboxEndpoint.runtimeAgentId === sandbox.character_id &&
    operation.expected_endpoint_sha256 === sandbox.activation_endpoint_sha256 &&
    agentActivationEndpointEnvelopesEqual(operationEndpoint, sandboxEndpoint) &&
    sandbox.activation_container_id === operation.expected_container_id &&
    sandbox.activation_node_id === operation.expected_node_id &&
    sandbox.activation_image_digest === operation.expected_image_digest &&
    sandbox.activation_boot_id === operation.expected_node_incarnation
  );
}

async function lockRecoverableRestoreQuarantine(
  tx: DbTransaction,
  operation: Readonly<AgentBackupRestoreOperation>,
): Promise<Readonly<AgentSandbox> | null> {
  const [sandbox] = await tx
    .select()
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, operation.agent_id),
        eq(agentSandboxes.organization_id, operation.organization_id),
        isNull(agentSandboxes.deleted_at),
        isNull(agentSandboxes.deletion_attempt_id),
        notInArray(agentSandboxes.status, ["deletion_pending", "deletion_failed"]),
      ),
    )
    .for("update")
    .limit(1);
  if (!sandbox || sandbox.activation_generation !== operation.restore_attempt_id) {
    return null;
  }
  if (!hasExactRecoverableRestoreQuarantine(operation, sandbox)) {
    throw new AgentBackupCatalogConflictError(
      "Restore quarantine cleanup authority diverged from its operation",
    );
  }
  return sandbox;
}

async function lockExactRestoreEndpointRuntime(
  tx: DbTransaction,
  operation: Readonly<AgentBackupRestoreOperation>,
  operationEndpoint: Readonly<AgentActivationEndpointEnvelopeV1>,
): Promise<Readonly<AgentSandbox>> {
  const [sandbox] = await tx
    .select()
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, operation.agent_id),
        eq(agentSandboxes.organization_id, operation.organization_id),
        eq(agentSandboxes.activation_generation, operation.restore_attempt_id),
        isNull(agentSandboxes.deleted_at),
        isNull(agentSandboxes.deletion_attempt_id),
        notInArray(agentSandboxes.status, ["deletion_pending", "deletion_failed"]),
      ),
    )
    .for("update")
    .limit(1);
  const sandboxEndpoint = sandbox
    ? parseAgentActivationEndpointAuthority(
        sandbox.activation_endpoint_envelope,
        sandbox.activation_endpoint_sha256,
        operation.restore_attempt_id,
      )
    : null;
  if (
    !sandbox ||
    sandbox.activation_purpose !== "restore" ||
    !["restore_pending", "restart_pending", "restart_attested", "active"].includes(
      sandbox.activation_phase ?? "",
    ) ||
    sandbox.character_id === null ||
    sandboxEndpoint === null ||
    operationEndpoint.runtimeAgentId !== sandbox.character_id ||
    sandboxEndpoint.runtimeAgentId !== sandbox.character_id ||
    operation.expected_endpoint_sha256 !== sandbox.activation_endpoint_sha256 ||
    !agentActivationEndpointEnvelopesEqual(operationEndpoint, sandboxEndpoint) ||
    sandbox.activation_container_id !== operation.expected_container_id ||
    sandbox.activation_node_id !== operation.expected_node_id ||
    sandbox.activation_image_digest !== operation.expected_image_digest ||
    sandbox.activation_boot_id !== operation.expected_node_incarnation
  ) {
    throw new AgentBackupCatalogConflictError(
      "Restore operation endpoint authority differs from its exact restore sandbox authority",
    );
  }
  return sandbox;
}

/**
 * A worker may perform remote restore work only while the operation still names
 * the exact live sandbox runtime it originally created. Retryable failures use
 * their durable resume phase because `failed_retryable` itself has no place in
 * the normal phase order.
 */
async function lockRequiredRestoreEndpointRuntime(
  tx: DbTransaction,
  operation: Readonly<AgentBackupRestoreOperation>,
): Promise<void> {
  const effectivePhase =
    operation.phase === "failed_retryable" ? operation.resume_phase : operation.phase;
  const effectiveRank = effectivePhase === null ? -1 : PHASE_ORDER.indexOf(effectivePhase);
  if (effectiveRank < PHASE_ORDER.indexOf("container_created")) return;

  const endpointAuthority = parseAgentActivationEndpointAuthority(
    operation.expected_endpoint_envelope,
    operation.expected_endpoint_sha256,
    operation.restore_attempt_id,
  );
  if (!endpointAuthority) {
    throw new AgentBackupCatalogConflictError(
      "Restore operation cannot run a container phase without complete endpoint authority",
    );
  }
  await lockExactRestoreEndpointRuntime(tx, operation, endpointAuthority);
}

async function clearRecoverableRestoreQuarantine(
  tx: DbTransaction,
  operation: Readonly<AgentBackupRestoreOperation>,
  sandbox: Readonly<AgentSandbox> | null,
  databaseNow: Date,
): Promise<void> {
  if (!sandbox) return;
  const [cleared] = await tx
    .update(agentSandboxes)
    .set({
      activation_generation: null,
      activation_previous_generation: null,
      activation_lifecycle_revision: null,
      activation_purpose: null,
      activation_phase: null,
      activation_backup_id: null,
      activation_backup_hash: null,
      activation_receipt: null,
      activation_receipt_hash: null,
      activation_container_id: null,
      activation_node_id: null,
      activation_image_digest: null,
      activation_endpoint_envelope: null,
      activation_endpoint_sha256: null,
      activation_token_hash: null,
      activation_token_ciphertext: null,
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
        eq(agentSandboxes.id, sandbox.id),
        eq(agentSandboxes.organization_id, operation.organization_id),
        eq(agentSandboxes.lifecycle_revision, sandbox.lifecycle_revision),
        eq(agentSandboxes.activation_generation, operation.restore_attempt_id),
        eq(agentSandboxes.activation_purpose, "restore"),
        isNull(agentSandboxes.deleted_at),
        isNull(agentSandboxes.deletion_attempt_id),
        notInArray(agentSandboxes.status, ["deletion_pending", "deletion_failed"]),
      ),
    )
    .returning({
      id: agentSandboxes.id,
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
      activationEndpointEnvelope: agentSandboxes.activation_endpoint_envelope,
      activationEndpointSha256: agentSandboxes.activation_endpoint_sha256,
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
    });
  if (!cleared || Object.entries(cleared).some(([key, value]) => key !== "id" && value !== null)) {
    throw new AgentBackupCatalogConflictError("Restore quarantine cleanup lost its sandbox CAS");
  }
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

    await lockRequiredRestoreEndpointRuntime(tx, operation);
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
    });
    const targetAlreadyRecorded = operation.expected_node_record_id !== null;
    if (targetAlreadyRecorded) {
      if (
        operation.expected_node_record_id !== target.nodeRecordId ||
        operation.expected_node_id !== target.nodeId ||
        operation.expected_node_incarnation !== target.nodeIncarnation ||
        operation.expected_node_history_id !== target.nodeHistoryId ||
        operation.expected_image_digest !== target.imageDigest ||
        operation.capacity_state !== "reserved" ||
        operation.capacity_reserved_at === null ||
        operation.capacity_settled_at !== null ||
        operation.capacity_settlement_receipt_digest !== null
      ) {
        throw new AgentBackupCatalogConflictError("Restore target replay authority mismatch");
      }
      return { operation: Object.freeze(operation), target, replayed: true };
    }
    if (
      operation.expected_node_id !== null ||
      operation.expected_node_incarnation !== null ||
      operation.expected_node_history_id !== null ||
      operation.expected_image_digest !== null ||
      operation.capacity_state !== null ||
      operation.capacity_reserved_at !== null ||
      operation.capacity_settled_at !== null ||
      operation.capacity_settlement_receipt_digest !== null
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
        expected_node_id: target.nodeId,
        expected_node_incarnation: target.nodeIncarnation,
        expected_node_history_id: target.nodeHistoryId,
        expected_image_digest: target.imageDigest,
        capacity_state: "reserved",
        capacity_reserved_at: databaseNow,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operationId),
          eq(agentBackupRestoreOperations.phase, operation.phase),
          eq(agentBackupRestoreOperations.claim_generation, claimGeneration),
          sql`${agentBackupRestoreOperations.expected_node_record_id} IS NULL`,
          sql`${agentBackupRestoreOperations.expected_node_id} IS NULL`,
          sql`${agentBackupRestoreOperations.expected_node_incarnation} IS NULL`,
          sql`${agentBackupRestoreOperations.expected_node_history_id} IS NULL`,
          sql`${agentBackupRestoreOperations.expected_image_digest} IS NULL`,
          sql`${agentBackupRestoreOperations.capacity_state} IS NULL`,
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
 * Release a restore-owned slot before it has been handed to a replacement.
 * The exact Docker-node occurrence, the durable ownership transition, and the
 * counter decrement commit together. A same-receipt retry observes the retained
 * terminal settlement and never decrements twice.
 */
export async function releaseAgentBackupRestoreCapacity(params: {
  operationId: string;
  ownerId: string;
  claimGeneration: string;
  settlementReceiptDigest: string;
}): Promise<ReleaseAgentBackupRestoreCapacityResult> {
  const operationId = requireUuid(params.operationId, "operationId");
  const claimGeneration = requireUuid(params.claimGeneration, "claimGeneration");
  const settlementReceiptDigest = requireSha256(
    params.settlementReceiptDigest,
    "settlementReceiptDigest",
  );
  requireOwnerId(params.ownerId);

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
    if (operation.capacity_state === "released") {
      if (operation.capacity_settlement_receipt_digest !== settlementReceiptDigest) {
        throw new AgentBackupCatalogConflictError("Restore capacity release replay mismatch");
      }
      return { operation: Object.freeze(operation), replayed: true };
    }
    if (operation.capacity_state === "handed_off") {
      throw new AgentBackupCatalogConflictError(
        "Restore capacity was already handed to its replacement",
      );
    }
    if (
      operation.capacity_state !== "reserved" ||
      operation.capacity_reserved_at === null ||
      operation.expected_node_record_id === null ||
      operation.expected_node_id === null ||
      operation.expected_node_incarnation === null ||
      operation.expected_node_history_id === null
    ) {
      throw new AgentBackupCatalogConflictError("Restore capacity is not durably reserved");
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
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) {
      throw new AgentBackupCatalogConflictError("Restore lease fence was lost");
    }

    const quarantine = await lockRecoverableRestoreQuarantine(tx, operation);
    const [node] = await tx
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, operation.expected_node_record_id))
      .for("update")
      .limit(1);
    const exactCurrentOccurrence = Boolean(
      node &&
        node.node_id === operation.expected_node_id &&
        node.node_incarnation === operation.expected_node_incarnation &&
        node.current_node_history_id === operation.expected_node_history_id,
    );
    if (node && exactCurrentOccurrence) {
      await proveExactAgentNodeOccurrenceForLockedNode(
        tx,
        node,
        operation.expected_node_incarnation,
        operation.expected_node_history_id,
      );
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
    if (node && exactCurrentOccurrence && node.allocated_count < 1) {
      throw new AgentBackupCatalogConflictError("Restore capacity counter is already empty");
    }

    await clearRecoverableRestoreQuarantine(tx, operation, quarantine, databaseNow);
    if (node && exactCurrentOccurrence) {
      const [releasedNode] = await tx
        .update(dockerNodes)
        .set({
          allocated_count: sql`${dockerNodes.allocated_count} - 1`,
          updated_at: databaseNow,
        })
        .where(
          and(
            eq(dockerNodes.id, operation.expected_node_record_id),
            eq(dockerNodes.node_id, operation.expected_node_id),
            eq(dockerNodes.node_incarnation, operation.expected_node_incarnation),
            eq(dockerNodes.current_node_history_id, operation.expected_node_history_id),
            sql`${dockerNodes.allocated_count} > 0`,
          ),
        )
        .returning({ id: dockerNodes.id });
      if (!releasedNode) {
        throw new AgentBackupCatalogConflictError("Restore capacity release lost its node CAS");
      }
    }

    const [releasedOperation] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        capacity_state: "released",
        capacity_settled_at: databaseNow,
        capacity_settlement_receipt_digest: settlementReceiptDigest,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operationId),
          eq(agentBackupRestoreOperations.capacity_state, "reserved"),
          eq(agentBackupRestoreOperations.claim_generation, claimGeneration),
        ),
      )
      .returning();
    if (!releasedOperation) {
      throw new AgentBackupCatalogConflictError("Restore capacity release lost its owner CAS");
    }
    return { operation: Object.freeze(releasedOperation), replayed: false };
  });
}

function isExactCapacityCrashRecoveryReplay(
  operation: Readonly<AgentBackupRestoreOperation>,
  cleanupProofDigest: string,
): boolean {
  return (
    operation.phase === "failed_terminal" &&
    operation.resume_phase === null &&
    operation.claim_owner === null &&
    operation.claim_generation === null &&
    operation.claim_expires_at === null &&
    operation.capacity_state === "released" &&
    operation.capacity_reserved_at !== null &&
    operation.capacity_settled_at !== null &&
    operation.capacity_settlement_receipt_digest === cleanupProofDigest &&
    operation.next_attempt_at.getTime() === operation.capacity_settled_at.getTime() &&
    operation.last_error_code === CAPACITY_CRASH_RECOVERY_ERROR_CODE &&
    operation.last_error === CAPACITY_CRASH_RECOVERY_ERROR &&
    operation.last_failure_generation === operation.lease_generation &&
    operation.last_failure_digest === cleanupProofDigest &&
    operation.receipt_digest === null &&
    operation.completed_at === null
  );
}

/**
 * Recover a slot retained by a crashed restore worker only after both of its
 * execution authorities are dead. The supplied digest is durable proof that
 * cleanup, or absence of the old occurrence, was established out of band.
 *
 * This is deliberately separate from the live-claim release path above. It
 * cannot extend or impersonate a claim: the immutable lease generation is
 * reused only as the terminal failure-replay generation, and the operation is
 * closed in the same transaction that settles its capacity owner.
 */
export async function recoverAgentBackupRestoreCapacityAfterCrash(params: {
  operationId: string;
  cleanupProofDigest: string;
}): Promise<RecoverAgentBackupRestoreCapacityAfterCrashResult> {
  const operationId = requireUuid(params.operationId, "operationId");
  const cleanupProofDigest = requireSha256(params.cleanupProofDigest, "cleanupProofDigest");

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
    const targetNodeRecordId = operation.expected_node_record_id;
    const targetNodeId = operation.expected_node_id;
    const targetNodeIncarnation = operation.expected_node_incarnation;
    const targetNodeHistoryId = operation.expected_node_history_id;
    if (
      targetNodeRecordId === null ||
      targetNodeId === null ||
      targetNodeIncarnation === null ||
      targetNodeHistoryId === null ||
      operation.expected_image_digest === null ||
      operation.capacity_reserved_at === null
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore capacity crash recovery lacks exact target authority",
      );
    }
    if (operation.phase === "failed_terminal") {
      if (!isExactCapacityCrashRecoveryReplay(operation, cleanupProofDigest)) {
        throw new AgentBackupCatalogConflictError(
          "Restore capacity crash recovery replay mismatch",
        );
      }
      return { operation: Object.freeze(operation), replayed: true };
    }
    if (operation.phase === "finalized") {
      throw new AgentBackupCatalogConflictError(
        "Restore capacity crash recovery cannot reopen a finalized operation",
      );
    }
    if (operation.capacity_state === "handed_off") {
      throw new AgentBackupCatalogConflictError(
        "Restore capacity was already handed to its replacement",
      );
    }
    const capacityWasAlreadyReleased = operation.capacity_state === "released";
    if (capacityWasAlreadyReleased) {
      if (
        operation.capacity_settled_at === null ||
        operation.capacity_settlement_receipt_digest !== cleanupProofDigest
      ) {
        throw new AgentBackupCatalogConflictError(
          "Restore capacity crash recovery release proof mismatch",
        );
      }
    } else if (
      operation.capacity_state !== "reserved" ||
      operation.capacity_settled_at !== null ||
      operation.capacity_settlement_receipt_digest !== null
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore capacity crash recovery requires reserved or exactly released ownership",
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

    const quarantine = await lockRecoverableRestoreQuarantine(tx, operation);
    const [node] = await tx
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, targetNodeRecordId))
      .for("update")
      .limit(1);
    const exactCurrentOccurrence = Boolean(
      node &&
        node.node_id === targetNodeId &&
        node.node_incarnation === targetNodeIncarnation &&
        node.current_node_history_id === targetNodeHistoryId,
    );
    if (node && exactCurrentOccurrence) {
      await proveExactAgentNodeOccurrenceForLockedNode(
        tx,
        node,
        targetNodeIncarnation,
        targetNodeHistoryId,
      );
    }

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at === null && lease.expires_at > databaseNow) {
      throw new AgentBackupCatalogConflictError(
        "Restore capacity crash recovery requires a non-live lease",
      );
    }
    const claimIsAbsent =
      operation.claim_owner === null &&
      operation.claim_generation === null &&
      operation.claim_expires_at === null;
    const claimIsExpired =
      operation.claim_owner !== null &&
      operation.claim_generation !== null &&
      operation.claim_expires_at !== null &&
      operation.claim_expires_at <= databaseNow;
    if (!claimIsAbsent && !claimIsExpired) {
      throw new AgentBackupCatalogConflictError(
        "Restore capacity crash recovery requires a non-live claim",
      );
    }

    if (!capacityWasAlreadyReleased && node && exactCurrentOccurrence && node.allocated_count < 1) {
      throw new AgentBackupCatalogConflictError("Restore capacity counter is already empty");
    }

    await clearRecoverableRestoreQuarantine(tx, operation, quarantine, databaseNow);
    if (!capacityWasAlreadyReleased && node && exactCurrentOccurrence) {
      const [releasedNode] = await tx
        .update(dockerNodes)
        .set({
          allocated_count: sql`${dockerNodes.allocated_count} - 1`,
          updated_at: databaseNow,
        })
        .where(
          and(
            eq(dockerNodes.id, targetNodeRecordId),
            eq(dockerNodes.node_id, targetNodeId),
            eq(dockerNodes.node_incarnation, targetNodeIncarnation),
            eq(dockerNodes.current_node_history_id, targetNodeHistoryId),
            sql`${dockerNodes.allocated_count} > 0`,
          ),
        )
        .returning({ id: dockerNodes.id });
      if (!releasedNode) {
        throw new AgentBackupCatalogConflictError(
          "Restore capacity crash recovery lost its node CAS",
        );
      }
    }

    const recoverySettlementAt = operation.capacity_settled_at ?? databaseNow;
    const [recovered] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        phase: "failed_terminal",
        resume_phase: null,
        claim_owner: null,
        claim_generation: null,
        claim_expires_at: null,
        next_attempt_at: recoverySettlementAt,
        ...(capacityWasAlreadyReleased
          ? {}
          : {
              capacity_state: "released" as const,
              capacity_settled_at: recoverySettlementAt,
              capacity_settlement_receipt_digest: cleanupProofDigest,
            }),
        last_error_code: CAPACITY_CRASH_RECOVERY_ERROR_CODE,
        last_error: CAPACITY_CRASH_RECOVERY_ERROR,
        last_failure_generation: operation.lease_generation,
        last_failure_digest: cleanupProofDigest,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operationId),
          eq(agentBackupRestoreOperations.phase, operation.phase),
          eq(agentBackupRestoreOperations.lease_generation, operation.lease_generation),
          capacityWasAlreadyReleased
            ? and(
                eq(agentBackupRestoreOperations.capacity_state, "released"),
                eq(agentBackupRestoreOperations.capacity_settled_at, recoverySettlementAt),
                eq(
                  agentBackupRestoreOperations.capacity_settlement_receipt_digest,
                  cleanupProofDigest,
                ),
              )
            : and(
                eq(agentBackupRestoreOperations.capacity_state, "reserved"),
                sql`${agentBackupRestoreOperations.capacity_settled_at} IS NULL`,
                sql`${agentBackupRestoreOperations.capacity_settlement_receipt_digest} IS NULL`,
              ),
          sql`(${agentBackupRestoreOperations.claim_expires_at} IS NULL
            OR ${agentBackupRestoreOperations.claim_expires_at} <= ${databaseNow})`,
        ),
      )
      .returning();
    if (!recovered) {
      throw new AgentBackupCatalogConflictError(
        "Restore capacity crash recovery lost its operation CAS",
      );
    }
    return { operation: Object.freeze(recovered), replayed: false };
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
  const resumingRecordedContainer = resuming && params.toPhase === "container_created";
  if (params.toPhase === "container_created" && !resumingRecordedContainer) {
    throw new AgentBackupCatalogConflictError(
      "Restore container creation must be recorded through quarantine authority",
    );
  }
  // Fail closed for structurally typed or JavaScript callers still sending the
  // retired generic identity bag. The quarantine writer is the only API allowed
  // to bind a container id and advance the matching phase atomically.
  if ("recordedIdentity" in params) {
    throw new AgentBackupCatalogConflictError(
      "Generic restore advance cannot record a container identity",
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

    const endpointAuthorityRequired = toRank >= PHASE_ORDER.indexOf("container_created");
    const endpointAuthority = endpointAuthorityRequired
      ? parseAgentActivationEndpointAuthority(
          operation.expected_endpoint_envelope,
          operation.expected_endpoint_sha256,
          operation.restore_attempt_id,
        )
      : null;
    if (endpointAuthorityRequired && !endpointAuthority) {
      throw new AgentBackupCatalogConflictError(
        "Restore operation cannot reach a container phase without complete endpoint authority",
      );
    }
    if (endpointAuthority) {
      await lockExactRestoreEndpointRuntime(tx, operation, endpointAuthority);
    }
    const endpointAuthorityCas = endpointAuthority
      ? and(
          isNotNull(agentBackupRestoreOperations.expected_endpoint_envelope),
          isNotNull(agentBackupRestoreOperations.expected_endpoint_sha256),
          eq(agentBackupRestoreOperations.expected_endpoint_envelope, endpointAuthority),
          eq(
            agentBackupRestoreOperations.expected_endpoint_sha256,
            hashAgentActivationEndpointEnvelope(endpointAuthority),
          ),
        )
      : undefined;

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
        operation.expected_node_id === null ||
        operation.expected_node_incarnation === null ||
        operation.expected_node_history_id === null ||
        operation.expected_image_digest === null ||
        operation.capacity_state === null)
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore operation cannot leave target reservation without complete target authority",
      );
    }
    if (targetAuthorityRequired && operation.capacity_state === "released") {
      throw new AgentBackupCatalogConflictError(
        "Restore operation cannot advance after releasing target capacity",
      );
    }
    if (params.toPhase === "finalized" && operation.capacity_state !== "handed_off") {
      throw new AgentBackupCatalogConflictError(
        "Restore finalization requires capacity handed to the adopted sandbox",
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
                isNotNull(agentBackupRestoreOperations.expected_node_id),
                isNotNull(agentBackupRestoreOperations.expected_node_incarnation),
                isNotNull(agentBackupRestoreOperations.expected_node_history_id),
                isNotNull(agentBackupRestoreOperations.expected_image_digest),
                isNotNull(agentBackupRestoreOperations.capacity_state),
                sql`${agentBackupRestoreOperations.capacity_state} <> 'released'`,
              )
            : undefined,
          params.toPhase === "finalized"
            ? eq(agentBackupRestoreOperations.capacity_state, "handed_off")
            : undefined,
          resumingRecordedContainer
            ? isNotNull(agentBackupRestoreOperations.expected_container_id)
            : undefined,
          endpointAuthorityCas,
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

    await lockRequiredRestoreEndpointRuntime(tx, operation);
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
    if (params.retryable && operation.capacity_state === "released") {
      throw new AgentBackupCatalogConflictError(
        "Restore operation cannot become retryable after releasing target capacity",
      );
    }
    if (!params.retryable && operation.capacity_state === "reserved") {
      throw new AgentBackupCatalogConflictError(
        "Restore operation cannot become terminal while it still owns capacity",
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
        last_error: params.error.slice(0, 2_000),
        last_failure_generation: claimGeneration,
        last_failure_digest: params.failureDigest,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operationId),
          eq(agentBackupRestoreOperations.claim_generation, claimGeneration),
          params.retryable
            ? sql`${agentBackupRestoreOperations.capacity_state} IS DISTINCT FROM 'released'`
            : sql`${agentBackupRestoreOperations.capacity_state} IS DISTINCT FROM 'reserved'`,
        ),
      )
      .returning();
    if (!failed) {
      throw new AgentBackupCatalogConflictError("Restore operation failure lost its CAS");
    }
    return Object.freeze(failed);
  });
}
