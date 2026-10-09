/** Durable grant-scoped claims; uses the existing primary database and no financial postings. */
import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bindRenewalInvoiceAuthority,
  type RenewalInvoiceAuthority,
} from "../../lib/services/renewal-invoice-authority";
import { bindRenewalInvoiceDetails } from "../../lib/services/renewal-invoice-details";
import { bindRenewalSettlementDetails } from "../../lib/services/renewal-settlement-details";
import { settlementDigest } from "../../lib/services/settlement-digest";
import { dbWrite, writeTransaction } from "../helpers";
import { organizations } from "../schemas/organizations";
import { subscriptionAdjustmentObservations as observations } from "../schemas/subscription-adjustment-observations";
import {
  subscriptionAdjustmentAttempts as attempts,
  subscriptionAdjustmentScans as scans,
} from "../schemas/subscription-adjustment-recovery";
import { subscriptionAllowancePeriods as periods } from "../schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions as grants } from "../schemas/subscription-allowance-transactions";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import type { AdjustmentRecoveryIdentity } from "./subscription-adjustment-lease";
import { requireAdjustmentLease } from "./subscription-adjustment-lease";
import { loadOriginalAdjustmentGrant } from "./subscription-adjustment-observations";

const request = z
  .object({
    organizationId: z.string().uuid(),
    grantId: z.string().uuid(),
    leaseDurationMs: z.number().int().min(100).max(60000).default(60000),
  })
  .strict();
function unavailable(): never {
  throw new ElizaError("Adjustment recovery claim is unavailable", {
    code: "SUBSCRIPTION_ADJUSTMENT_CLAIM_UNAVAILABLE",
  });
}
export async function claimRenewalAdjustment(value: z.input<typeof request>) {
  const parsed = request.safeParse(value);
  if (!parsed.success) unavailable();
  const input = parsed.data;
  return writeTransaction(async (tx) => {
    // The loader locks the organization before any scan/attempt mutation. A changed head
    // while waiting is rejected, and a future discovery pass may claim it again.
    const [head] = await tx
      .select({ id: observations.id })
      .from(observations)
      .where(eq(observations.grant_id, input.grantId))
      .orderBy(desc(observations.version))
      .limit(1);
    const attemptId = randomUUID();
    const original = await loadOriginalAdjustmentGrant(tx, {
      organizationId: input.organizationId,
      grantId: input.grantId,
      requestId: attemptId,
      expectedPreviousId: head?.id ?? null,
    });
    if (original.existing) unavailable();
    const metadata = original.grant.metadata;
    const authority = bindRenewalInvoiceAuthority(
      metadata.renewalInvoiceAuthority as RenewalInvoiceAuthority,
      original.original,
      original.period.stripe_invoice_id!,
      original.grant.request_digest,
    );
    const invoice = bindRenewalInvoiceDetails(metadata.renewalInvoiceDetails, authority);
    bindRenewalSettlementDetails(metadata.renewalSettlementDetails, invoice, authority);
    if (!authority.providerAccountId) unavailable();
    await tx
      .insert(scans)
      .values({
        grant_id: input.grantId,
        organization_id: input.organizationId,
        next_due_at: original.databaseNow,
      })
      .onConflictDoNothing();
    const [scan] = await tx
      .select()
      .from(scans)
      .where(eq(scans.grant_id, input.grantId))
      .for("update");
    if (!scan || scan.organization_id !== input.organizationId) unavailable();
    const [pending] = await tx
      .select()
      .from(attempts)
      .where(and(eq(attempts.grant_id, input.grantId), eq(attempts.disposition, "processing")))
      .for("update");
    const now = await readPostLockDatabaseNow(tx);
    if (pending && pending.expires_at > now) return null;
    if (pending)
      await tx
        .update(attempts)
        .set({ disposition: "superseded", reason: "lease_expired", completed_at: now })
        .where(eq(attempts.id, pending.id));
    if (scan.next_due_at > now) return null;
    const generation = scan.generation + 1,
      leaseToken = randomUUID(),
      originalDigest = settlementDigest(metadata);
    await tx.update(scans).set({ generation }).where(eq(scans.grant_id, input.grantId));
    await tx.insert(attempts).values({
      id: attemptId,
      organization_id: input.organizationId,
      grant_id: input.grantId,
      generation,
      lease_token: leaseToken,
      expected_previous_id: head?.id ?? null,
      original_digest: originalDigest,
      started_at: now,
      expires_at: new Date(now.getTime() + input.leaseDurationMs),
    });
    const identity: AdjustmentRecoveryIdentity = {
      organizationId: input.organizationId,
      grantId: input.grantId,
      attemptId,
      generation,
      leaseToken,
      originalDigest,
    };
    return {
      identity,
      request: {
        organizationId: input.organizationId,
        grantId: input.grantId,
        requestId: attemptId,
        expectedPreviousId: head?.id ?? null,
      },
    };
  });
}

/** Failure bookkeeping carries only a fixed reason, never provider text or credentials. */
export async function failRenewalAdjustment(
  input: AdjustmentRecoveryIdentity,
  reason: "provider_unavailable" | "stale_observation",
) {
  if (!["provider_unavailable", "stale_observation"].includes(reason)) unavailable();
  return writeTransaction(async (tx) => {
    const [org] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!org) unavailable();
    const { scan, now } = await requireAdjustmentLease(tx, input);
    await tx
      .update(attempts)
      .set({ disposition: "failed", reason, completed_at: now })
      .where(eq(attempts.id, input.attemptId));
    const failures = scan.failures + 1;
    await tx
      .update(scans)
      .set({
        failures,
        next_due_at: new Date(
          now.getTime() + Math.min(3600000, 30000 * 2 ** Math.min(failures - 1, 7)),
        ),
      })
      .where(eq(scans.grant_id, input.grantId));
  });
}

/** Discovery is grant-scoped, including original invoices of terminal subscriptions.
 * Legacy evidence is included for explicit unavailable reporting, never synthesized. */
export async function listDueRenewalAdjustmentGrants(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) unavailable();
  return dbWrite
    .select({ organizationId: grants.organization_id, grantId: grants.id })
    .from(grants)
    .innerJoin(periods, eq(periods.id, grants.allowance_period_id))
    .innerJoin(organizations, eq(organizations.id, grants.organization_id))
    .leftJoin(scans, eq(scans.grant_id, grants.id))
    .where(
      and(
        eq(grants.kind, "grant"),
        eq(grants.merchant_key, "platform"),
        isNull(grants.billing_scope_id),
        eq(periods.grant_source, "paid_invoice"),
        eq(periods.organization_id, grants.organization_id),
        eq(organizations.is_active, true),
        eq(organizations.account_lifecycle_state, "active"),
        isNull(organizations.paid_work_fenced_at),
        isNull(organizations.account_deletion_request_id),
        sql`(${scans.next_due_at} IS NULL OR ${scans.next_due_at}<=clock_timestamp())`,
        sql`NOT EXISTS (SELECT 1 FROM subscription_adjustment_attempts a WHERE a.grant_id=${grants.id} AND a.disposition='processing' AND a.expires_at>clock_timestamp())`,
      ),
    )
    .orderBy(sql`COALESCE(${scans.next_due_at},${grants.created_at})`, grants.id)
    .limit(limit);
}

/** Resolves incident ownership from the original funded period, never from provider input. */
export async function readAdjustmentIncidentSource(input: {
  organizationId: string;
  grantId: string;
}) {
  const [row] = await dbWrite
    .select({ subscriptionId: periods.subscription_id })
    .from(grants)
    .innerJoin(periods, eq(periods.id, grants.allowance_period_id))
    .where(
      and(
        eq(grants.id, input.grantId),
        eq(grants.organization_id, input.organizationId),
        eq(periods.organization_id, input.organizationId),
        eq(grants.kind, "grant"),
        eq(grants.merchant_key, "platform"),
        isNull(grants.billing_scope_id),
        eq(periods.merchant_key, "platform"),
        isNull(periods.billing_scope_id),
        eq(periods.grant_source, "paid_invoice"),
      ),
    )
    .limit(1);
  if (!row?.subscriptionId) unavailable();
  return { ...input, subscriptionId: row.subscriptionId };
}

/** Back off unclaimable historical evidence after its incident has been durably reported.
 * Never modifies an active claim or fabricates an original evidence snapshot. */
export async function deferUnavailableRenewalAdjustment(input: {
  organizationId: string;
  grantId: string;
}) {
  await readAdjustmentIncidentSource(input);
  return writeTransaction(async (tx) => {
    const [org] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!org) unavailable();
    const admittedAt = await readPostLockDatabaseNow(tx);
    await tx
      .insert(scans)
      .values({
        grant_id: input.grantId,
        organization_id: input.organizationId,
        next_due_at: admittedAt,
      })
      .onConflictDoNothing();
    const [scan] = await tx
      .select()
      .from(scans)
      .where(eq(scans.grant_id, input.grantId))
      .for("update");
    if (!scan || scan.organization_id !== input.organizationId) unavailable();
    const [pending] = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.grant_id, input.grantId), eq(attempts.disposition, "processing")))
      .for("update");
    const now = await readPostLockDatabaseNow(tx);
    // An expired worker still owns an immutable receipt; the next successful claim
    // supersedes it. Deferral must not silently complete or replace that attempt.
    if (pending || scan.next_due_at > now) return false;
    const failures = scan.failures + 1;
    await tx
      .update(scans)
      .set({
        failures,
        next_due_at: new Date(
          now.getTime() + Math.min(3600000, 30000 * 2 ** Math.min(failures - 1, 7)),
        ),
      })
      .where(eq(scans.grant_id, input.grantId));
    return true;
  });
}
