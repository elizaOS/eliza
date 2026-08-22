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
import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { requireBoundedIdentity } from "../../lib/services/agent-backup-catalog-state";
import { isValidUUID } from "../../lib/utils/validation";
import { dbWrite } from "../helpers";
import {
  type AgentBackupRestoreOperation,
  type AgentBackupRestorePhase,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "../schemas/agent-backup-catalog";
import { agentSandboxBackups } from "../schemas/agent-sandboxes";
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
        operation.expected_node_incarnation !== target.nodeIncarnation ||
        operation.expected_node_history_id !== target.nodeHistoryId ||
        operation.expected_image_digest !== target.imageDigest
      ) {
        throw new AgentBackupCatalogConflictError("Restore target replay authority mismatch");
      }
      return { operation: Object.freeze(operation), target, replayed: true };
    }
    if (
      operation.expected_node_incarnation !== null ||
      operation.expected_node_history_id !== null ||
      operation.expected_image_digest !== null
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
        last_error: params.error.slice(0, 2_000),
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
