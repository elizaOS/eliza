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
  requireOwnerId(authority.ownerId);

  return await dbWrite.transaction(async (tx) => {
    // Catalogue authority before lease: acquire/renew/release all take the
    // authority first, and taking them the other way round here would deadlock
    // a replay against a concurrent renewal.
    const catalogAuthority = await lockAgentBackupCatalogAuthority(tx, organizationId, agentId);
    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, leaseId),
          eq(agentBackupRestoreLeases.organization_id, organizationId),
          eq(agentBackupRestoreLeases.agent_id, agentId),
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
  const identity = params.recordedIdentity ?? {};
  if ((identity.nodeRecordId === undefined) !== (identity.nodeIncarnation === undefined)) {
    throw new AgentBackupCatalogConflictError(
      "Recording a node identity requires both the record id and the incarnation",
    );
  }
  if (identity.nodeRecordId !== undefined) requireUuid(identity.nodeRecordId, "nodeRecordId");
  if (identity.nodeIncarnation !== undefined) {
    requireUuid(identity.nodeIncarnation, "nodeIncarnation");
  }
  if (identity.containerId !== undefined) requireSha256(identity.containerId, "containerId");
  if (identity.imageDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(identity.imageDigest)) {
    throw new AgentBackupCatalogConflictError("imageDigest must be a canonical sha256 reference");
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

    if (resuming && operation.resume_phase !== params.toPhase) {
      throw new AgentBackupCatalogConflictError(
        `Restore operation must resume ${operation.resume_phase}, not ${params.toPhase}`,
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
