/** Discovers original unfunded invoices and claims their existing receipt; no provider or funding effects. */
import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { bindSubscriptionInvoiceEventEvidence } from "../../lib/services/subscription-invoice-event-evidence";
import type { DbTransaction } from "../client";
import { dbWrite, writeTransaction } from "../helpers";
import { organizations } from "../schemas/organizations";
import {
  subscriptionBillingFences as fences,
  subscriptionInvoiceEventEvidence as originals,
  billingSubscriptionEventReceipts as receipts,
} from "../schemas/subscription-billing-operations";
import { subscriptionBillingOperationsRepository as operations } from "./subscription-billing-operations";

const requestSchema = z
  .object({
    organizationId: z.string().uuid(),
    receiptId: z.string().uuid(),
    leaseDurationMs: z.number().int().min(100).max(60_000).default(60_000),
  })
  .strict();
function unavailable(): never {
  throw new ElizaError("Original invoice recovery claim is unavailable", {
    code: "SUBSCRIPTION_INVOICE_RECOVERY_UNAVAILABLE",
  });
}
function dueOriginals(executor: typeof dbWrite | DbTransaction = dbWrite) {
  return executor
    .select({ receipt: receipts, evidence: originals.evidence })
    .from(originals)
    .innerJoin(
      receipts,
      and(
        eq(receipts.id, originals.receipt_id),
        eq(receipts.organization_id, originals.organization_id),
      ),
    )
    .innerJoin(organizations, eq(organizations.id, receipts.organization_id))
    .leftJoin(
      fences,
      and(
        eq(fences.organization_id, receipts.organization_id),
        eq(fences.subscription_id, receipts.subscription_id),
        isNull(fences.billing_scope_id),
        eq(fences.merchant_key, "platform"),
      ),
    );
}
function eligible() {
  return and(
    isNull(receipts.billing_scope_id),
    eq(receipts.merchant_key, "platform"),
    eq(receipts.provider_object_type, "invoice"),
    eq(receipts.event_type, "invoice.paid"),
    eq(organizations.is_active, true),
    eq(organizations.account_lifecycle_state, "active"),
    isNull(organizations.account_deletion_request_id),
    isNull(organizations.paid_work_fenced_at),
    or(isNull(fences.id), eq(fences.state, "open")),
    // An observation is not collection proof. Only originally observed debit balances enter this lane.
    sql`((${originals.evidence}->'event'->'data'->'object'->>'starting_balance')::numeric > 0 OR (${originals.evidence}->'event'->'data'->'object'->>'ending_balance')::numeric > 0)`,
    sql`((${receipts.status}='received' AND (${receipts.attempt_count}=0 OR ${receipts.updated_at} + LEAST(3600,60*power(2,LEAST(${receipts.attempt_count}-1,6))) * interval '1 second' <= clock_timestamp())) OR (${receipts.status}='processing' AND ${receipts.lease_expires_at}<=clock_timestamp()))`,
  );
}
/** Historical/terminal subscriptions and changed current items do not remove original invoice work. */
export async function listDueOriginalInvoiceEvents(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) unavailable();
  const rows = await dueOriginals()
    .where(eligible())
    .orderBy(asc(receipts.updated_at), asc(receipts.id))
    .limit(limit);
  return rows.map(({ receipt }) => ({
    organizationId: receipt.organization_id,
    receiptId: receipt.id,
  }));
}
export async function claimOriginalInvoiceEvent(raw: z.input<typeof requestSchema>) {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) unavailable();
  const input = parsed.data;
  return writeTransaction(async (tx) => {
    // Follow the existing lifecycle lock order; provider reads must happen after this transaction.
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!organization) return null;
    const [row] = await dueOriginals(tx)
      .where(
        and(
          eligible(),
          eq(receipts.organization_id, input.organizationId),
          eq(receipts.id, input.receiptId),
        ),
      )
      .limit(1)
      .for("update", { of: receipts });
    if (!row) return null;
    const evidence = bindSubscriptionInvoiceEventEvidence(row.evidence, {
      ...row.evidence.scope,
      organizationId: row.receipt.organization_id,
      subscriptionId: row.receipt.subscription_id,
      providerEventId: row.receipt.provider_event_id,
      invoiceId: row.receipt.provider_object_id,
      livemode: row.receipt.livemode,
    });
    const leaseToken = randomUUID();
    const receipt = await operations.claimEvent({ ...input, leaseToken }, tx);
    if (!receipt) return null;
    return {
      organizationId: input.organizationId,
      receiptId: receipt.id,
      leaseToken,
      attempt: receipt.attempt_count,
      expiresAt: receipt.lease_expires_at!,
      evidence,
    };
  });
}
