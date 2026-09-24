/** Validates the durable observation lease under organization serialization before source publication and final receipt CAS. */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../client";
import {
  subscriptionReconciliationAttempts,
  subscriptionReconciliationScans,
} from "../schemas/subscription-reconciliation";
import { readPostLockDatabaseNow } from "./primary-database-clock";
export interface ReconciliationIdentity {
  organizationId: string;
  subscriptionId: string;
  attemptId: string;
  generation: number;
  leaseToken: string;
  expectedRevision: number;
  identityDigest: string;
}
export async function readReconciliationLease(tx: DbTransaction, input: ReconciliationIdentity) {
  const [scan] = await tx
    .select()
    .from(subscriptionReconciliationScans)
    .where(
      and(
        eq(subscriptionReconciliationScans.organization_id, input.organizationId),
        eq(subscriptionReconciliationScans.subscription_id, input.subscriptionId),
      ),
    )
    .for("update");
  const [attempt] = await tx
    .select()
    .from(subscriptionReconciliationAttempts)
    .where(
      and(
        eq(subscriptionReconciliationAttempts.id, input.attemptId),
        eq(subscriptionReconciliationAttempts.organization_id, input.organizationId),
      ),
    )
    .for("update");
  if (
    !scan ||
    !attempt ||
    attempt.subscription_id !== input.subscriptionId ||
    attempt.generation !== input.generation ||
    attempt.lease_token !== input.leaseToken ||
    attempt.expected_revision !== input.expectedRevision ||
    attempt.identity_digest !== input.identityDigest
  )
    throw new ElizaError("Reconciliation receipt identity does not match this observation", {
      code: "SUBSCRIPTION_RECONCILIATION_IDENTITY_MISMATCH",
    });
  return { scan, attempt };
}
export async function requireLiveReconciliationLease(
  tx: DbTransaction,
  input: ReconciliationIdentity,
) {
  const { scan, attempt } = await readReconciliationLease(tx, input);
  const now = await readPostLockDatabaseNow(tx);
  if (
    scan.generation !== input.generation ||
    attempt.disposition !== "processing" ||
    attempt.expires_at <= now
  )
    throw new ElizaError("Reconciliation lease is no longer current", {
      code: "SUBSCRIPTION_RECONCILIATION_LEASE_LOST",
    });
  return { scan, attempt, now };
}
