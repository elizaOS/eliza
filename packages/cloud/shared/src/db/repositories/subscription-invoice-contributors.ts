/** Receipt-owned contributor snapshots; no new queue or financial publication. */
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  bindSubscriptionInvoiceEventEvidence,
  type SubscriptionInvoiceEventEvidence,
} from "../../lib/services/subscription-invoice-event-evidence";
import type { DbTransaction } from "../client";
import {
  subscriptionBillingFences as fences,
  subscriptionInvoiceEventEvidence as originals,
  billingSubscriptionEventReceipts as receipts,
} from "../schemas/subscription-billing-operations";

function unavailable(): never {
  throw new ElizaError("Original invoice contributors are unavailable or fenced", {
    code: "SUBSCRIPTION_INVOICE_DEBT_SOURCES_UNAVAILABLE",
  });
}
/** Caller owns the organization lock. Initial reads retain all candidate fence states;
 * final publication locks and requires open fences only for the implicated invoices. */
export async function loadOriginalInvoiceContributors(
  tx: DbTransaction,
  collector: SubscriptionInvoiceEventEvidence,
  lockInvoiceIds?: string[],
) {
  const scope = collector.scope;
  if (lockInvoiceIds && !lockInvoiceIds.length) unavailable();
  const rows = await tx
    .select({ receipt: receipts, original: originals })
    .from(originals)
    .innerJoin(
      receipts,
      and(
        eq(receipts.id, originals.receipt_id),
        eq(receipts.organization_id, originals.organization_id),
      ),
    )
    .where(
      and(
        eq(originals.organization_id, scope.organizationId),
        isNull(receipts.billing_scope_id),
        eq(receipts.merchant_key, "platform"),
        eq(receipts.livemode, scope.livemode),
        eq(receipts.provider_object_type, "invoice"),
        eq(receipts.event_type, "invoice.paid"),
        sql`${originals.evidence}->'scope'->>'providerAccountId' = ${scope.providerAccountId}`,
        sql`${originals.evidence}->'scope'->>'customerId' = ${scope.customerId}`,
        lockInvoiceIds ? inArray(receipts.provider_object_id, lockInvoiceIds) : undefined,
      ),
    )
    .orderBy(asc(receipts.id))
    .limit(10_001);
  if (rows.length > 10_000 || !rows.length) unavailable();
  const bound = rows.map(({ receipt, original }) => ({
    receiptId: receipt.id,
    evidence: bindSubscriptionInvoiceEventEvidence(original.evidence, {
      ...original.evidence.scope,
      organizationId: scope.organizationId,
      providerAccountId: scope.providerAccountId,
      customerId: scope.customerId,
      subscriptionId: receipt.subscription_id,
      invoiceId: receipt.provider_object_id,
      providerEventId: receipt.provider_event_id,
      livemode: receipt.livemode,
    }),
  }));
  if (lockInvoiceIds?.some((id) => !bound.some((row) => row.evidence.scope.invoiceId === id)))
    unavailable();
  const sourceIds = [...new Set(bound.map((row) => row.evidence.scope.subscriptionId))].sort();
  const query = tx
    .select()
    .from(fences)
    .where(
      and(
        eq(fences.organization_id, scope.organizationId),
        isNull(fences.billing_scope_id),
        eq(fences.merchant_key, "platform"),
        inArray(fences.subscription_id, sourceIds),
      ),
    )
    .orderBy(asc(fences.subscription_id));
  const sourceFences = lockInvoiceIds ? await query.for("update") : await query;
  if (lockInvoiceIds && sourceFences.some((fence) => fence.state !== "open")) unavailable();
  return bound.map((row) => {
    const fence = sourceFences.find(
      (fence) => fence.subscription_id === row.evidence.scope.subscriptionId,
    );
    return {
      ...row,
      fence: fence ? { id: fence.id, revision: fence.fence_revision, state: fence.state } : null,
    };
  });
}
