/**
 * Repository for the destination-bound transfer record (round 4, #21631
 * close directive). The record is the durable ledger of ONE promotion
 * attempt: created bound to a destination host, advanced through
 * `created → delivering → finalized → promoted | aborted`, and accumulating
 * per-batch and finalize replay receipts. Resume discipline is enforced
 * here: an epoch's record can only ever be continued against the SAME
 * destination host it was bound to.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../client";
import {
  type SharedTransferRecordRow,
  sharedTransferRecords,
} from "../schemas/shared-transfer-records";
import type { SharedAgentMemoryScope } from "./shared-agent-memories";

export const SHARED_TRANSFER_RECORD_DESTINATION_MISMATCH =
  "SHARED_TRANSFER_RECORD_DESTINATION_MISMATCH";
export const SHARED_TRANSFER_RECORD_NOT_FOUND = "SHARED_TRANSFER_RECORD_NOT_FOUND";

function scopeEpochPredicate(scope: SharedAgentMemoryScope, epoch: number) {
  return and(
    eq(sharedTransferRecords.organization_id, scope.organizationId),
    eq(sharedTransferRecords.user_id, scope.userId),
    eq(sharedTransferRecords.agent_id, scope.agentId),
    eq(sharedTransferRecords.epoch, epoch),
  );
}

/**
 * Create the record for a fresh epoch, or return the existing one after
 * verifying the destination host matches its binding. The unique index on
 * (scope, epoch) makes concurrent creates race at the database.
 */
export async function createOrResumeRecord(
  scope: SharedAgentMemoryScope,
  epoch: number,
  destinationHost: string,
): Promise<{ record: SharedTransferRecordRow; resumed: boolean }> {
  const [existing] = await dbRead
    .select()
    .from(sharedTransferRecords)
    .where(scopeEpochPredicate(scope, epoch))
    .limit(1);
  if (existing) {
    if (existing.destination_host !== destinationHost) {
      throw new ElizaError("Transfer record is bound to a different destination", {
        code: SHARED_TRANSFER_RECORD_DESTINATION_MISMATCH,
        context: { bound: existing.destination_host, requested: destinationHost },
      });
    }
    return { record: existing, resumed: true };
  }
  const [created] = await dbWrite
    .insert(sharedTransferRecords)
    .values({
      organization_id: scope.organizationId,
      user_id: scope.userId,
      agent_id: scope.agentId,
      epoch,
      destination_host: destinationHost,
      state: "created",
      receipts: [],
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { record: created, resumed: false };
  // Lost a concurrent create race — re-read and destination-check.
  return createOrResumeRecord(scope, epoch, destinationHost);
}

/** Append one replay receipt and advance updated_at atomically. */
export async function appendReceipt(
  scope: SharedAgentMemoryScope,
  epoch: number,
  receipt: Record<string, unknown>,
): Promise<void> {
  const updated = await dbWrite
    .update(sharedTransferRecords)
    .set({
      receipts: sql`${sharedTransferRecords.receipts} || ${JSON.stringify([receipt])}::jsonb`,
      updated_at: new Date(),
    })
    .where(scopeEpochPredicate(scope, epoch))
    .returning({ id: sharedTransferRecords.id });
  if (!updated[0]) {
    throw new ElizaError("Transfer record not found for receipt append", {
      code: SHARED_TRANSFER_RECORD_NOT_FOUND,
      context: { epoch },
    });
  }
}

/** Advance the record's delivery state (and optionally seal/batch facts). */
export async function setRecordState(
  scope: SharedAgentMemoryScope,
  epoch: number,
  state: "delivering" | "finalized" | "promoted" | "aborted",
  facts: { sealDigest?: string; batchCount?: number } = {},
): Promise<void> {
  const updated = await dbWrite
    .update(sharedTransferRecords)
    .set({
      state,
      ...(facts.sealDigest ? { seal_digest: facts.sealDigest } : {}),
      ...(facts.batchCount !== undefined ? { batch_count: facts.batchCount } : {}),
      updated_at: new Date(),
    })
    .where(scopeEpochPredicate(scope, epoch))
    .returning({ id: sharedTransferRecords.id });
  if (!updated[0]) {
    throw new ElizaError("Transfer record not found for state advance", {
      code: SHARED_TRANSFER_RECORD_NOT_FOUND,
      context: { epoch, state },
    });
  }
}

/** Read the record (receipts included) for resume/audit. */
export async function getRecord(
  scope: SharedAgentMemoryScope,
  epoch: number,
): Promise<SharedTransferRecordRow | null> {
  const [row] = await dbRead
    .select()
    .from(sharedTransferRecords)
    .where(scopeEpochPredicate(scope, epoch))
    .limit(1);
  return row ?? null;
}
