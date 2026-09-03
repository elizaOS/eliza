/** Durable claim and fenced settlement for restore-v3 candidate cleanup. */

import { Buffer } from "node:buffer";
import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { isValidUUID } from "../../lib/utils/validation";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
  type AgentBackupRestoreV3CandidateCleanup,
  agentBackupRestoreV3CandidateCleanupOutbox,
} from "../schemas/agent-backup-restore-v3-candidates";
import {
  computeAgentBackupRestoreV3CleanupReasonSha256,
  computeAgentBackupRestoreV3CleanupReceiptSha256,
  exactDigestMatches,
} from "./agent-backup-restore-v3-candidate-codec";
import {
  applyAgentBackupRestoreV3TransactionDeadline,
  assertAgentBackupRestoreV3OperationControl,
  snapshotAgentBackupRestoreV3OperationControl,
  throwIfAgentBackupRestoreV3DatabaseDeadline,
} from "./agent-backup-restore-v3-candidate-database-control";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const MIN_CLEANUP_LEASE_MS = 1_000;
const MAX_CLEANUP_LEASE_MS = 3_600_000;
const MAX_CLEANUP_DEFER_MS = 86_400_000;

export class AgentBackupRestoreV3CandidateCleanupConflictError extends Error {
  readonly code = "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CLEANUP_CONFLICT";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentBackupRestoreV3CandidateCleanupConflictError";
  }
}

export interface AgentBackupRestoreV3CandidateCleanupClaim {
  readonly cleanupId: string;
  readonly organizationId: string;
  readonly agentId: string;
  readonly backupId: string;
  readonly restoreAttemptId: string;
  readonly operationId: string;
  readonly ownerId: string;
  readonly generation: string;
  readonly attempt: number;
  readonly leaseExpiresAt: Date;
  readonly databaseNow: Date;
  readonly replayed: boolean;
}

export interface AgentBackupRestoreV3CandidateCleanupFence {
  readonly cleanupId: string;
  readonly ownerId: string;
  readonly generation: string;
  readonly attempt: number;
}

export interface AgentBackupRestoreV3CandidateCleanupOutcome {
  readonly cleanupId: string;
  readonly state: "pending" | "completed" | "quarantined";
  readonly attempt: number;
  readonly nextAttemptAt: Date;
  readonly databaseNow: Date;
  readonly replayed: boolean;
}

function conflict(
  message: string,
  cause?: unknown,
): AgentBackupRestoreV3CandidateCleanupConflictError {
  return new AgentBackupRestoreV3CandidateCleanupConflictError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function requireUuid(value: string, field: string): string {
  if (!isValidUUID(value) || value !== value.toLowerCase()) {
    throw conflict(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function requireOwner(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (value !== value.trim() || bytes < 1 || bytes > 255 || value.includes("\0")) {
    throw conflict("ownerId must contain between 1 and 255 trimmed UTF-8 bytes");
  }
  return value;
}

function requireBoundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw conflict(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function asDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw conflict(`Database returned an invalid ${field}`);
  return date;
}

function requireFence(
  input: Readonly<AgentBackupRestoreV3CandidateCleanupFence>,
): AgentBackupRestoreV3CandidateCleanupFence {
  return Object.freeze({
    cleanupId: requireUuid(input.cleanupId, "cleanupId"),
    ownerId: requireOwner(input.ownerId),
    generation: requireUuid(input.generation, "generation"),
    attempt: requireBoundedInteger(input.attempt, "attempt", 1, 2_147_483_647),
  });
}

function claimFromRow(
  row: AgentBackupRestoreV3CandidateCleanup,
  databaseNow: Date,
  replayed: boolean,
): AgentBackupRestoreV3CandidateCleanupClaim {
  if (
    row.state !== "leased" ||
    row.claim_owner === null ||
    row.claim_generation === null ||
    row.lease_expires_at === null
  ) {
    throw conflict("Cleanup claim row is not a complete leased authority");
  }
  return Object.freeze({
    cleanupId: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    backupId: row.backup_id,
    restoreAttemptId: row.restore_attempt_id,
    operationId: row.operation_id,
    ownerId: row.claim_owner,
    generation: row.claim_generation,
    attempt: row.attempts,
    leaseExpiresAt: asDate(row.lease_expires_at, "cleanup lease expiry"),
    databaseNow,
    replayed,
  });
}

function outcomeFromRow(
  row: AgentBackupRestoreV3CandidateCleanup,
  databaseNow: Date,
  replayed: boolean,
): AgentBackupRestoreV3CandidateCleanupOutcome {
  if (row.state !== "pending" && row.state !== "completed" && row.state !== "quarantined") {
    throw conflict("Cleanup outcome row is not pending or terminal");
  }
  return Object.freeze({
    cleanupId: row.id,
    state: row.state,
    attempt: row.attempts,
    nextAttemptAt: asDate(row.next_attempt_at, "cleanup next-attempt timestamp"),
    databaseNow,
    replayed,
  });
}

async function lockExactClaim(
  tx: DbTransaction,
  ownerId: string,
  generation: string,
): Promise<AgentBackupRestoreV3CandidateCleanup | undefined> {
  const rows = await tx
    .select()
    .from(agentBackupRestoreV3CandidateCleanupOutbox)
    .where(
      and(
        eq(agentBackupRestoreV3CandidateCleanupOutbox.state, "leased"),
        eq(agentBackupRestoreV3CandidateCleanupOutbox.claim_owner, ownerId),
        eq(agentBackupRestoreV3CandidateCleanupOutbox.claim_generation, generation),
      ),
    )
    .for("update")
    .limit(2);
  if (rows.length > 1) {
    throw conflict("Cleanup claim generation is not unique for this owner");
  }
  return rows[0];
}

async function lockClaimGeneration(
  tx: DbTransaction,
  ownerId: string,
  generation: string,
): Promise<void> {
  // The current schema has no durable owner+generation claim-key table. A
  // transaction-scoped 64-bit advisory lock serializes the predicate before
  // either exact replay or SKIP LOCKED selection. Hash collisions can only
  // over-serialize unrelated claimants; they cannot admit duplicate fences.
  const claimKey = `restore-v3-candidate-cleanup-claim:v1:${ownerId.length}:${ownerId}:${generation}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${claimKey}, 0))`);
}

/**
 * Claim one due cleanup. Expired leases are normalized leased -> pending ->
 * leased in this same PRIMARY transaction, exactly as the table guard requires.
 */
export async function claimAgentBackupRestoreV3CandidateCleanup(input: {
  readonly ownerId: string;
  readonly generation: string;
  readonly leaseMs: number;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
}): Promise<AgentBackupRestoreV3CandidateCleanupClaim | null> {
  input = Object.freeze({
    ...input,
    control: snapshotAgentBackupRestoreV3OperationControl(input.control),
  });
  assertAgentBackupRestoreV3OperationControl(input.control, "Restore-v3 candidate cleanup claim");
  const ownerId = requireOwner(input.ownerId);
  const generation = requireUuid(input.generation, "generation");
  const leaseMs = requireBoundedInteger(
    input.leaseMs,
    "leaseMs",
    MIN_CLEANUP_LEASE_MS,
    MAX_CLEANUP_LEASE_MS,
  );
  try {
    return await dbWrite.transaction(async (tx) => {
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup claim",
      );
      await lockClaimGeneration(tx, ownerId, generation);
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup claim",
      );
      const exact = await lockExactClaim(tx, ownerId, generation);
      if (exact) {
        const databaseNow = await readPostLockDatabaseNow(tx);
        if (
          exact.lease_expires_at !== null &&
          asDate(exact.lease_expires_at, "cleanup lease expiry").getTime() > databaseNow.getTime()
        ) {
          assertAgentBackupRestoreV3OperationControl(
            input.control,
            "Restore-v3 candidate cleanup claim",
          );
          return claimFromRow(exact, databaseNow, true);
        }
      }

      let due = exact;
      if (!due) {
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          input.control,
          "Restore-v3 candidate cleanup claim",
        );
        const [selected] = await tx
          .select()
          .from(agentBackupRestoreV3CandidateCleanupOutbox)
          .where(sql`(
            (${agentBackupRestoreV3CandidateCleanupOutbox.state} = 'pending'
              AND ${agentBackupRestoreV3CandidateCleanupOutbox.next_attempt_at} <= clock_timestamp())
            OR (${agentBackupRestoreV3CandidateCleanupOutbox.state} = 'leased'
              AND ${agentBackupRestoreV3CandidateCleanupOutbox.lease_expires_at} <= clock_timestamp())
          )`)
          .orderBy(
            asc(agentBackupRestoreV3CandidateCleanupOutbox.next_attempt_at),
            asc(agentBackupRestoreV3CandidateCleanupOutbox.created_at),
            asc(agentBackupRestoreV3CandidateCleanupOutbox.id),
          )
          .for("update", { skipLocked: true })
          .limit(1);
        due = selected;
      }
      if (!due) {
        assertAgentBackupRestoreV3OperationControl(
          input.control,
          "Restore-v3 candidate cleanup claim",
        );
        return null;
      }
      const databaseNow = await readPostLockDatabaseNow(tx);
      if (due.state === "leased") {
        if (
          due.lease_expires_at === null ||
          asDate(due.lease_expires_at, "cleanup lease expiry").getTime() > databaseNow.getTime()
        ) {
          assertAgentBackupRestoreV3OperationControl(
            input.control,
            "Restore-v3 candidate cleanup claim",
          );
          return null;
        }
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          input.control,
          "Restore-v3 candidate cleanup claim",
        );
        const [recovered] = await tx
          .update(agentBackupRestoreV3CandidateCleanupOutbox)
          .set({
            state: "pending",
            claim_owner: null,
            claim_generation: null,
            lease_expires_at: null,
            next_attempt_at: sql`GREATEST(
              ${agentBackupRestoreV3CandidateCleanupOutbox.next_attempt_at},
              ${databaseNow}
            )`,
          })
          .where(
            and(
              eq(agentBackupRestoreV3CandidateCleanupOutbox.id, due.id),
              eq(agentBackupRestoreV3CandidateCleanupOutbox.state, "leased"),
              eq(agentBackupRestoreV3CandidateCleanupOutbox.claim_owner, due.claim_owner as string),
              eq(
                agentBackupRestoreV3CandidateCleanupOutbox.claim_generation,
                due.claim_generation as string,
              ),
            ),
          )
          .returning();
        if (!recovered) throw conflict("Expired cleanup lease recovery lost its CAS");
      }
      const expiresAt = new Date(databaseNow.getTime() + leaseMs);
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup claim",
      );
      const [claimed] = await tx
        .update(agentBackupRestoreV3CandidateCleanupOutbox)
        .set({
          state: "leased",
          claim_owner: ownerId,
          claim_generation: generation,
          lease_expires_at: expiresAt,
          attempts: sql`${agentBackupRestoreV3CandidateCleanupOutbox.attempts} + 1`,
        })
        .where(
          and(
            eq(agentBackupRestoreV3CandidateCleanupOutbox.id, due.id),
            eq(agentBackupRestoreV3CandidateCleanupOutbox.state, "pending"),
          ),
        )
        .returning();
      if (!claimed) throw conflict("Cleanup claim lost its pending-to-leased CAS");
      assertAgentBackupRestoreV3OperationControl(
        input.control,
        "Restore-v3 candidate cleanup claim",
      );
      return claimFromRow(claimed, databaseNow, false);
    });
  } catch (cause) {
    throwIfAgentBackupRestoreV3DatabaseDeadline(cause, "Restore-v3 candidate cleanup claim");
    // A commit may have succeeded even if its response did not. Reconcile only
    // the exact owner+generation on PRIMARY. Advisory + row lock + PRIMARY
    // clock share this transaction, so terminalized, expired, or reassigned
    // authority can never be returned as a live lease.
    return dbWrite.transaction(async (tx) => {
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup claim recovery",
      );
      await lockClaimGeneration(tx, ownerId, generation);
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup claim recovery",
      );
      const exact = await lockExactClaim(tx, ownerId, generation);
      const databaseNow = await readPostLockDatabaseNow(tx);
      if (
        exact?.lease_expires_at &&
        asDate(exact.lease_expires_at, "cleanup lease expiry").getTime() > databaseNow.getTime()
      ) {
        assertAgentBackupRestoreV3OperationControl(
          input.control,
          "Restore-v3 candidate cleanup claim recovery",
        );
        return claimFromRow(exact, databaseNow, true);
      }
      throw cause;
    });
  }
}

/** Settle one exact live cleanup fence, with same-receipt terminal replay. */
export async function settleAgentBackupRestoreV3CandidateCleanup(input: {
  readonly fence: Readonly<AgentBackupRestoreV3CandidateCleanupFence>;
  readonly cleanupReceiptSha256: string;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
}): Promise<AgentBackupRestoreV3CandidateCleanupOutcome> {
  input = Object.freeze({
    ...input,
    control: snapshotAgentBackupRestoreV3OperationControl(input.control),
  });
  assertAgentBackupRestoreV3OperationControl(input.control, "Restore-v3 candidate cleanup settle");
  const fence = requireFence(input.fence);
  const receiptSha256 = computeAgentBackupRestoreV3CleanupReceiptSha256(input.cleanupReceiptSha256);
  try {
    return await dbWrite.transaction(async (tx) => {
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup settle",
      );
      const [current] = await tx
        .select()
        .from(agentBackupRestoreV3CandidateCleanupOutbox)
        .where(eq(agentBackupRestoreV3CandidateCleanupOutbox.id, fence.cleanupId))
        .for("update")
        .limit(1);
      if (!current) throw conflict("Cleanup authority is missing");
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup settle",
      );
      const databaseNow = await readPostLockDatabaseNow(tx);
      if (current.state === "completed") {
        if (
          current.attempts !== fence.attempt ||
          !exactDigestMatches(current.receipt_sha256 ?? "", receiptSha256)
        ) {
          throw conflict("Cleanup settlement replay receipt differs");
        }
        assertAgentBackupRestoreV3OperationControl(
          input.control,
          "Restore-v3 candidate cleanup settle",
        );
        return outcomeFromRow(current, databaseNow, true);
      }
      requireLiveFence(current, fence, databaseNow);
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup settle",
      );
      const [settled] = await tx
        .update(agentBackupRestoreV3CandidateCleanupOutbox)
        .set({
          state: "completed",
          claim_owner: null,
          claim_generation: null,
          lease_expires_at: null,
          receipt_sha256: receiptSha256,
        })
        .where(exactLiveFenceSql(fence, databaseNow))
        .returning();
      if (!settled) throw conflict("Cleanup settlement lost its live fence CAS");
      assertAgentBackupRestoreV3OperationControl(
        input.control,
        "Restore-v3 candidate cleanup settle",
      );
      return outcomeFromRow(settled, databaseNow, false);
    });
  } catch (cause) {
    throwIfAgentBackupRestoreV3DatabaseDeadline(cause, "Restore-v3 candidate cleanup settle");
    return dbWrite.transaction(async (tx) => {
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup settle recovery",
      );
      const [current] = await tx
        .select()
        .from(agentBackupRestoreV3CandidateCleanupOutbox)
        .where(eq(agentBackupRestoreV3CandidateCleanupOutbox.id, fence.cleanupId))
        .for("update")
        .limit(1);
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup settle recovery",
      );
      const databaseNow = await readPostLockDatabaseNow(tx);
      if (current?.state === "completed") {
        if (
          current.attempts !== fence.attempt ||
          !exactDigestMatches(current.receipt_sha256 ?? "", receiptSha256)
        ) {
          throw conflict("Cleanup settlement replay receipt differs", cause);
        }
        assertAgentBackupRestoreV3OperationControl(
          input.control,
          "Restore-v3 candidate cleanup settle recovery",
        );
        return outcomeFromRow(current, databaseNow, true);
      }
      throw cause;
    });
  }
}

/** Defer one exact live cleanup fence by a PRIMARY-clock duration. */
export async function deferAgentBackupRestoreV3CandidateCleanup(input: {
  readonly fence: Readonly<AgentBackupRestoreV3CandidateCleanupFence>;
  readonly delayMs: number;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
}): Promise<AgentBackupRestoreV3CandidateCleanupOutcome> {
  input = Object.freeze({
    ...input,
    control: snapshotAgentBackupRestoreV3OperationControl(input.control),
  });
  assertAgentBackupRestoreV3OperationControl(input.control, "Restore-v3 candidate cleanup defer");
  const fence = requireFence(input.fence);
  const delayMs = requireBoundedInteger(input.delayMs, "delayMs", 1, MAX_CLEANUP_DEFER_MS);
  let databaseNow: Date | undefined;
  try {
    return await dbWrite.transaction(async (tx) => {
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup defer",
      );
      const [current] = await tx
        .select()
        .from(agentBackupRestoreV3CandidateCleanupOutbox)
        .where(eq(agentBackupRestoreV3CandidateCleanupOutbox.id, fence.cleanupId))
        .for("update")
        .limit(1);
      if (!current) throw conflict("Cleanup authority is missing");
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup defer",
      );
      databaseNow = await readPostLockDatabaseNow(tx);
      requireLiveFence(current, fence, databaseNow);
      const nextAttemptAt = new Date(databaseNow.getTime() + delayMs);
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup defer",
      );
      const [deferred] = await tx
        .update(agentBackupRestoreV3CandidateCleanupOutbox)
        .set({
          state: "pending",
          claim_owner: null,
          claim_generation: null,
          lease_expires_at: null,
          next_attempt_at: sql`GREATEST(
            ${agentBackupRestoreV3CandidateCleanupOutbox.next_attempt_at},
            ${nextAttemptAt}
          )`,
        })
        .where(exactLiveFenceSql(fence, databaseNow))
        .returning();
      if (!deferred) throw conflict("Cleanup defer lost its live fence CAS");
      assertAgentBackupRestoreV3OperationControl(
        input.control,
        "Restore-v3 candidate cleanup defer",
      );
      return outcomeFromRow(deferred, databaseNow, false);
    });
  } catch (cause) {
    throwIfAgentBackupRestoreV3DatabaseDeadline(cause, "Restore-v3 candidate cleanup defer");
    return dbWrite.transaction(async (tx) => {
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup defer recovery",
      );
      const [current] = await tx
        .select()
        .from(agentBackupRestoreV3CandidateCleanupOutbox)
        .where(eq(agentBackupRestoreV3CandidateCleanupOutbox.id, fence.cleanupId))
        .for("update")
        .limit(1);
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup defer recovery",
      );
      const recoveryNow = await readPostLockDatabaseNow(tx);
      // attempts is the durable claim-cycle fence. No later claimant can
      // preserve it, and the row lock prevents adoption during this proof.
      if (
        current?.state === "pending" &&
        current.attempts === fence.attempt &&
        current.claim_owner === null &&
        current.claim_generation === null &&
        current.lease_expires_at === null &&
        databaseNow !== undefined &&
        asDate(current.next_attempt_at, "cleanup next-attempt timestamp").getTime() >=
          databaseNow.getTime() + delayMs
      ) {
        assertAgentBackupRestoreV3OperationControl(
          input.control,
          "Restore-v3 candidate cleanup defer recovery",
        );
        return outcomeFromRow(current, recoveryNow, true);
      }
      throw cause;
    });
  }
}

/** Quarantine one exact live cleanup fence, retaining only a reason digest. */
export async function quarantineAgentBackupRestoreV3CandidateCleanup(input: {
  readonly fence: Readonly<AgentBackupRestoreV3CandidateCleanupFence>;
  readonly reason: string;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
}): Promise<AgentBackupRestoreV3CandidateCleanupOutcome> {
  input = Object.freeze({
    ...input,
    control: snapshotAgentBackupRestoreV3OperationControl(input.control),
  });
  assertAgentBackupRestoreV3OperationControl(
    input.control,
    "Restore-v3 candidate cleanup quarantine",
  );
  const fence = requireFence(input.fence);
  const reasonSha256 = computeAgentBackupRestoreV3CleanupReasonSha256(input.reason);
  try {
    return await dbWrite.transaction(async (tx) => {
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup quarantine",
      );
      const [current] = await tx
        .select()
        .from(agentBackupRestoreV3CandidateCleanupOutbox)
        .where(eq(agentBackupRestoreV3CandidateCleanupOutbox.id, fence.cleanupId))
        .for("update")
        .limit(1);
      if (!current) throw conflict("Cleanup authority is missing");
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup quarantine",
      );
      const databaseNow = await readPostLockDatabaseNow(tx);
      if (current.state === "quarantined") {
        if (
          current.attempts !== fence.attempt ||
          !exactDigestMatches(current.quarantine_reason_sha256 ?? "", reasonSha256)
        ) {
          throw conflict("Cleanup quarantine replay reason differs");
        }
        assertAgentBackupRestoreV3OperationControl(
          input.control,
          "Restore-v3 candidate cleanup quarantine",
        );
        return outcomeFromRow(current, databaseNow, true);
      }
      requireLiveFence(current, fence, databaseNow);
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup quarantine",
      );
      const [quarantined] = await tx
        .update(agentBackupRestoreV3CandidateCleanupOutbox)
        .set({
          state: "quarantined",
          claim_owner: null,
          claim_generation: null,
          lease_expires_at: null,
          quarantine_reason_sha256: reasonSha256,
        })
        .where(exactLiveFenceSql(fence, databaseNow))
        .returning();
      if (!quarantined) throw conflict("Cleanup quarantine lost its live fence CAS");
      assertAgentBackupRestoreV3OperationControl(
        input.control,
        "Restore-v3 candidate cleanup quarantine",
      );
      return outcomeFromRow(quarantined, databaseNow, false);
    });
  } catch (cause) {
    throwIfAgentBackupRestoreV3DatabaseDeadline(cause, "Restore-v3 candidate cleanup quarantine");
    return dbWrite.transaction(async (tx) => {
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup quarantine recovery",
      );
      const [current] = await tx
        .select()
        .from(agentBackupRestoreV3CandidateCleanupOutbox)
        .where(eq(agentBackupRestoreV3CandidateCleanupOutbox.id, fence.cleanupId))
        .for("update")
        .limit(1);
      await applyAgentBackupRestoreV3TransactionDeadline(
        tx,
        input.control,
        "Restore-v3 candidate cleanup quarantine recovery",
      );
      const databaseNow = await readPostLockDatabaseNow(tx);
      if (current?.state === "quarantined") {
        if (
          current.attempts !== fence.attempt ||
          !exactDigestMatches(current.quarantine_reason_sha256 ?? "", reasonSha256)
        ) {
          throw conflict("Cleanup quarantine replay reason differs", cause);
        }
        assertAgentBackupRestoreV3OperationControl(
          input.control,
          "Restore-v3 candidate cleanup quarantine recovery",
        );
        return outcomeFromRow(current, databaseNow, true);
      }
      throw cause;
    });
  }
}

function requireLiveFence(
  row: AgentBackupRestoreV3CandidateCleanup,
  fence: AgentBackupRestoreV3CandidateCleanupFence,
  databaseNow: Date,
): void {
  if (
    row.state !== "leased" ||
    row.id !== fence.cleanupId ||
    row.claim_owner !== fence.ownerId ||
    row.claim_generation !== fence.generation ||
    row.attempts !== fence.attempt ||
    row.lease_expires_at === null ||
    asDate(row.lease_expires_at, "cleanup lease expiry").getTime() <= databaseNow.getTime()
  ) {
    throw conflict("Cleanup settlement requires its exact live owner, generation, and attempt");
  }
}

function exactLiveFenceSql(
  fence: AgentBackupRestoreV3CandidateCleanupFence,
  databaseNow: Date,
): ReturnType<typeof and> {
  return and(
    eq(agentBackupRestoreV3CandidateCleanupOutbox.id, fence.cleanupId),
    eq(agentBackupRestoreV3CandidateCleanupOutbox.state, "leased"),
    eq(agentBackupRestoreV3CandidateCleanupOutbox.claim_owner, fence.ownerId),
    eq(agentBackupRestoreV3CandidateCleanupOutbox.claim_generation, fence.generation),
    eq(agentBackupRestoreV3CandidateCleanupOutbox.attempts, fence.attempt),
    sql`${agentBackupRestoreV3CandidateCleanupOutbox.lease_expires_at} > ${databaseNow}`,
  );
}
