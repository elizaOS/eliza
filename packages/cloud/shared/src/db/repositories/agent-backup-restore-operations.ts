/**
 * Durable phase store for one restore attempt.
 *
 * A restore has one side effect per phase and each is expensive or destructive,
 * so every effect's exact identity is recorded before it is attempted: a worker
 * that loses its response re-reads the recorded identity and verifies, instead
 * of re-running the effect. The fencing token is the lease's own `generation` —
 * a second token would let the operation outlive the authority it rests on.
 *
 * Nothing here creates containers or contacts an agent; this is the spine those
 * later phases hang from.
 */

import { and, eq, notInArray } from "drizzle-orm";
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
  AgentBackupCatalogConflictError,
  lockAgentBackupCatalogAuthority,
} from "./agent-backup-catalog";
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

export interface OpenAgentBackupRestoreOperationInput {
  authority: AgentBackupRestoreLeaseAuthorityReceipt;
  leaseId: string;
}

export interface AgentBackupRestoreOperationClaim {
  operation: Readonly<AgentBackupRestoreOperation>;
  claimGeneration: string;
  databaseNow: Date;
}

function requireUuid(value: string, field: string): string {
  if (!isValidUUID(value) || value !== value.toLowerCase()) {
    throw new AgentBackupCatalogConflictError(`${field} must be a canonical lowercase UUID`);
  }
  return value;
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
  const restoreAttemptId = requireUuid(authority.restoreAttemptId, "restoreAttemptId");
  const leaseId = requireUuid(input.leaseId, "leaseId");
  const fencingToken = requireUuid(authority.fencingToken, "fencingToken");
  requireBoundedIdentity(authority.ownerId, "ownerId");

  return await dbWrite.transaction(async (tx) => {
    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, leaseId),
          eq(agentBackupRestoreLeases.organization_id, organizationId),
          eq(agentBackupRestoreLeases.backup_id, backupId),
          eq(agentBackupRestoreLeases.restore_attempt_id, restoreAttemptId),
          eq(agentBackupRestoreLeases.generation, fencingToken),
          eq(agentBackupRestoreLeases.owner_id, authority.ownerId),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) {
      throw new AgentBackupCatalogConflictError("Restore lease authority does not match");
    }

    // The catalogue epoch is re-proved here, not inherited from the receipt: a
    // revision advanced between acquire and open invalidates the attempt, and an
    // operation row is permanent once written.
    const catalogAuthority = await lockAgentBackupCatalogAuthority(tx, organizationId, agentId);
    if (catalogAuthority.catalog_revision !== lease.catalog_epoch) {
      throw new AgentBackupCatalogConflictError(
        "Restore attempt was invalidated by a catalogue revision",
      );
    }

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at <= databaseNow) {
      throw new AgentBackupCatalogConflictError("Restore lease is expired or released");
    }

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
    if (existing) {
      if (
        existing.agent_id !== agentId ||
        existing.backup_id !== backupId ||
        existing.lease_id !== leaseId ||
        existing.lease_generation !== fencingToken ||
        existing.lease_owner_id !== authority.ownerId ||
        existing.catalog_epoch !== lease.catalog_epoch ||
        existing.copy_role !== lease.copy_role ||
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
 * Take a claim on one due operation. Discovery is not authorization: the row is
 * re-locked and every fence re-proved inside the claiming transaction.
 */
export async function claimAgentBackupRestoreOperation(params: {
  operationId: string;
  ownerId: string;
  claimMs: number;
}): Promise<AgentBackupRestoreOperationClaim> {
  const operationId = requireUuid(params.operationId, "operationId");
  requireBoundedIdentity(params.ownerId, "ownerId");
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
 * Advance one phase under a live claim, optionally recording the side effect's
 * identity in the same statement that moves the phase — so the record and the
 * transition cannot disagree.
 */
export async function advanceAgentBackupRestoreOperation(params: {
  operationId: string;
  ownerId: string;
  claimGeneration: string;
  fromPhase: AgentBackupRestorePhase;
  toPhase: AgentBackupRestorePhase;
  recordedIdentity?: {
    nodeRecordId?: string;
    nodeIncarnation?: string;
    containerId?: string;
    imageDigest?: string;
  };
  receiptDigest?: string;
}): Promise<Readonly<AgentBackupRestoreOperation>> {
  const operationId = requireUuid(params.operationId, "operationId");
  const claimGeneration = requireUuid(params.claimGeneration, "claimGeneration");
  const fromRank = PHASE_ORDER.indexOf(params.fromPhase);
  const toRank = PHASE_ORDER.indexOf(params.toPhase);
  if (fromRank < 0 || toRank < 0 || toRank <= fromRank) {
    throw new AgentBackupCatalogConflictError(
      `Restore operation cannot advance from ${params.fromPhase} to ${params.toPhase}`,
    );
  }
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

    const identity = params.recordedIdentity ?? {};
    const [advanced] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        phase: params.toPhase,
        resume_phase: null,
        claim_owner: null,
        claim_generation: null,
        claim_expires_at: null,
        ...(identity.nodeRecordId !== undefined
          ? { expected_node_record_id: identity.nodeRecordId }
          : {}),
        ...(identity.nodeIncarnation !== undefined
          ? { expected_node_incarnation: identity.nodeIncarnation }
          : {}),
        ...(identity.containerId !== undefined
          ? { expected_container_id: identity.containerId }
          : {}),
        ...(identity.imageDigest !== undefined
          ? { expected_image_digest: identity.imageDigest }
          : {}),
        ...(params.receiptDigest !== undefined
          ? { receipt_digest: params.receiptDigest, completed_at: databaseNow }
          : {}),
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operationId),
          eq(agentBackupRestoreOperations.phase, params.fromPhase),
          eq(agentBackupRestoreOperations.claim_generation, claimGeneration),
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
 * Record a failure. A retryable failure pins the phase to re-enter so a later
 * claim cannot resume somewhere cheaper; a terminal one closes the operation.
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
  if (!PHASE_ORDER.includes(params.resumePhase) || params.resumePhase === "finalized") {
    throw new AgentBackupCatalogConflictError(`${params.resumePhase} is not a resumable phase`);
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
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (
      operation.claim_owner !== params.ownerId ||
      operation.claim_generation !== claimGeneration
    ) {
      throw new AgentBackupCatalogConflictError("Restore operation claim is not live");
    }

    const [failed] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        phase: params.retryable ? "failed_retryable" : "failed_terminal",
        resume_phase: params.retryable ? params.resumePhase : null,
        claim_owner: null,
        claim_generation: null,
        claim_expires_at: null,
        next_attempt_at: new Date(databaseNow.getTime() + Math.max(0, params.retryDelayMs)),
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
