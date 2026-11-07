/** Validates grant observation leases under the same organization lock as journal publication. */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../client";
import {
  subscriptionAdjustmentAttempts as attempts,
  subscriptionAdjustmentScans as scans,
} from "../schemas/subscription-adjustment-recovery";
import { readPostLockDatabaseNow } from "./primary-database-clock";
export interface AdjustmentRecoveryIdentity {
  organizationId: string;
  grantId: string;
  attemptId: string;
  generation: number;
  leaseToken: string;
  originalDigest: string;
}
function lost(): never {
  throw new ElizaError("Adjustment observation lease is no longer authoritative", {
    code: "SUBSCRIPTION_ADJUSTMENT_LEASE_LOST",
  });
}
export async function readAdjustmentLease(tx: DbTransaction, input: AdjustmentRecoveryIdentity) {
  const [scan] = await tx
    .select()
    .from(scans)
    .where(eq(scans.grant_id, input.grantId))
    .for("update");
  const [attempt] = await tx
    .select()
    .from(attempts)
    .where(
      and(eq(attempts.id, input.attemptId), eq(attempts.organization_id, input.organizationId)),
    )
    .for("update");
  if (
    !scan ||
    !attempt ||
    scan.organization_id !== input.organizationId ||
    attempt.grant_id !== input.grantId ||
    attempt.generation !== input.generation ||
    attempt.lease_token !== input.leaseToken ||
    attempt.original_digest !== input.originalDigest
  )
    lost();
  return { scan, attempt, now: await readPostLockDatabaseNow(tx) };
}
export async function requireAdjustmentLease(tx: DbTransaction, input: AdjustmentRecoveryIdentity) {
  const state = await readAdjustmentLease(tx, input);
  if (
    state.scan.generation !== input.generation ||
    state.attempt.disposition !== "processing" ||
    state.attempt.expires_at <= state.now
  )
    lost();
  return state;
}
export async function completeAdjustmentLease(
  tx: DbTransaction,
  input: AdjustmentRecoveryIdentity,
  observationId: string,
) {
  const state = await readAdjustmentLease(tx, input);
  if (state.attempt.disposition === "recorded") {
    if (state.attempt.observation_id !== observationId) lost();
    return;
  }
  if (
    state.scan.generation !== input.generation ||
    state.attempt.disposition !== "processing" ||
    state.attempt.expires_at <= state.now
  )
    lost();
  await tx
    .update(attempts)
    .set({ disposition: "recorded", observation_id: observationId, completed_at: state.now })
    .where(eq(attempts.id, input.attemptId));
  await tx
    .update(scans)
    .set({ failures: 0, next_due_at: new Date(state.now.getTime() + 3600000) })
    .where(eq(scans.grant_id, input.grantId));
}
