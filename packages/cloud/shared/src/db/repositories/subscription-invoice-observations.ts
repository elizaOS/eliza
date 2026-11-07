/** Receipt-owned read observations; never financial application or a second recovery queue. */
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { observeOriginalInvoiceDebt } from "../../lib/services/observed-invoice-debt";
import { observeRetainedInvoiceBalance } from "../../lib/services/retained-invoice-balance-observation";
import { settlementDigest } from "../../lib/services/settlement-digest";
import { bindSubscriptionInvoiceEventEvidence } from "../../lib/services/subscription-invoice-event-evidence";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import { organizations } from "../schemas/organizations";
import {
  subscriptionBillingFences as fences,
  subscriptionInvoiceObservations as observations,
  subscriptionInvoiceEventEvidence as originals,
  billingSubscriptionEventReceipts as receipts,
} from "../schemas/subscription-billing-operations";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import { loadOriginalInvoiceContributors } from "./subscription-invoice-contributors";

const request = z
  .object({
    organizationId: z.string().uuid(),
    receiptId: z.string().uuid(),
    leaseToken: z.string().uuid(),
  })
  .strict();
function unavailable(): never {
  throw new ElizaError("Original invoice observation publication is unavailable or stale", {
    code: "SUBSCRIPTION_INVOICE_OBSERVATION_UNAVAILABLE",
  });
}
async function load(
  tx: DbTransaction,
  input: z.infer<typeof request>,
  contributorInvoiceIds?: string[],
) {
  const [org] = await tx
    .select({
      is_active: organizations.is_active,
      account_lifecycle_state: organizations.account_lifecycle_state,
      account_deletion_request_id: organizations.account_deletion_request_id,
      paid_work_fenced_at: organizations.paid_work_fenced_at,
    })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .for("update");
  if (
    !org ||
    !org.is_active ||
    org.account_lifecycle_state !== "active" ||
    org.account_deletion_request_id ||
    org.paid_work_fenced_at
  )
    unavailable();
  const [receipt] = await tx
    .select()
    .from(receipts)
    .where(
      and(eq(receipts.id, input.receiptId), eq(receipts.organization_id, input.organizationId)),
    )
    .for("update");
  if (
    !receipt ||
    receipt.billing_scope_id !== null ||
    receipt.merchant_key !== "platform" ||
    receipt.provider_object_type !== "invoice" ||
    receipt.event_type !== "invoice.paid"
  )
    unavailable();
  const [fence] = await tx
    .select()
    .from(fences)
    .where(
      and(
        eq(fences.organization_id, input.organizationId),
        eq(fences.subscription_id, receipt.subscription_id),
        isNull(fences.billing_scope_id),
        eq(fences.merchant_key, "platform"),
      ),
    )
    .for("update");
  if (fence && fence.state !== "open") unavailable();
  const [original] = await tx
    .select()
    .from(originals)
    .where(
      and(
        eq(originals.receipt_id, receipt.id),
        eq(originals.organization_id, input.organizationId),
      ),
    );
  if (!original) unavailable();
  const evidence = bindSubscriptionInvoiceEventEvidence(original.evidence, {
    ...original.evidence.scope,
    organizationId: receipt.organization_id,
    subscriptionId: receipt.subscription_id,
    providerEventId: receipt.provider_event_id,
    invoiceId: receipt.provider_object_id,
    livemode: receipt.livemode,
  });
  if (
    evidence.event.data.object.starting_balance <= 0 &&
    evidence.event.data.object.ending_balance <= 0
  )
    unavailable();
  const [existing] = await tx
    .select()
    .from(observations)
    .where(
      and(eq(observations.receipt_id, receipt.id), eq(observations.request_id, input.leaseToken)),
    );
  // A completed attempt is immutable. Replay never takes or releases a newer worker's lease.
  if (existing) {
    if (existing.observation.kind === "observed_original_invoice_debt") {
      const saved = existing.observation;
      const current = await loadOriginalInvoiceContributors(tx, evidence, [
        evidence.scope.invoiceId,
        ...saved.originals.map((row) => row.invoiceId),
      ]);
      for (const row of saved.originals)
        for (const digest of row.originalEvidenceDigests)
          if (
            !current.some(
              (source) =>
                source.evidence.digest === digest &&
                source.evidence.scope.invoiceId === row.invoiceId,
            )
          )
            unavailable();
    }
    return { existing } as const;
  }
  const now = await readPostLockDatabaseNow(tx);
  if (
    receipt.status !== "processing" ||
    receipt.lease_token !== input.leaseToken ||
    !receipt.lease_expires_at ||
    receipt.lease_expires_at <= now
  )
    unavailable();
  const [head] = await tx
    .select()
    .from(observations)
    .where(eq(observations.receipt_id, receipt.id))
    .orderBy(desc(observations.version))
    .limit(1);
  return {
    evidence,
    contributors:
      evidence.event.data.object.starting_balance > 0 && evidence.event.data.object.amount_due > 0
        ? await loadOriginalInvoiceContributors(tx, evidence, contributorInvoiceIds)
        : [],
    now,
    version: (head?.version ?? 0) + 1,
    previousId: head?.id ?? null,
    fence: fence ? { id: fence.id, revision: fence.fence_revision } : null,
  } as const;
}
/** Private server operation. Reads occur outside locks. The original claim token is also
 * the publication request id, so retries return the first durable result without refreshing it.
 * Observing releases the receipt for later reads; only separately proven financial application
 * may make the original invoice terminal. Caller handles provider failures with existing retry ownership. */
export async function observeAndRecordOriginalInvoice(
  value: z.infer<typeof request>,
  stripe: Parameters<typeof observeOriginalInvoiceDebt>[1],
) {
  const parsed = request.safeParse(value);
  if (!parsed.success) unavailable();
  const input = parsed.data;
  const before = await writeTransaction((tx) => load(tx, input));
  if (before.existing) return { observation: before.existing, replayed: true };
  const initial = before.evidence.event.data.object;
  // Select from immutable original facts. Never promote a deferred original using later payment pointers.
  const evidence =
    initial.starting_balance > 0 && initial.amount_due > 0
      ? await observeOriginalInvoiceDebt(
          { collector: before.evidence, originals: before.contributors.map((row) => row.evidence) },
          stripe,
        )
      : await observeRetainedInvoiceBalance(before.evidence, stripe);
  return writeTransaction(async (tx) => {
    const contributorIds =
      evidence.kind === "observed_original_invoice_debt"
        ? [evidence.invoiceId, ...evidence.originals.map((row) => row.invoiceId)]
        : undefined;
    const after = await load(tx, input, contributorIds);
    if (after.existing) return { observation: after.existing, replayed: true };
    if (
      after.evidence.digest !== before.evidence.digest ||
      after.version !== before.version ||
      after.previousId !== before.previousId ||
      settlementDigest(after.fence) !== settlementDigest(before.fence) ||
      settlementDigest(after.contributors) !==
        settlementDigest(
          before.contributors.filter(
            (row) => !contributorIds || contributorIds.includes(row.evidence.scope.invoiceId),
          ),
        )
    )
      unavailable();
    const [saved] = await tx
      .insert(observations)
      .values({
        organization_id: input.organizationId,
        receipt_id: input.receiptId,
        request_id: input.leaseToken,
        version: after.version,
        previous_id: after.previousId,
        observation: evidence,
        observed_at: after.now,
      })
      .returning();
    if (!saved) unavailable();
    const [released] = await tx
      .update(receipts)
      .set({
        status: "received",
        lease_token: null,
        lease_expires_at: null,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(receipts.id, input.receiptId),
          eq(receipts.organization_id, input.organizationId),
          eq(receipts.status, "processing"),
          eq(receipts.lease_token, input.leaseToken),
          sql`${receipts.lease_expires_at}>clock_timestamp()`,
        ),
      )
      .returning({ id: receipts.id });
    if (!released) unavailable(); // Roll back the observation if lease expiry races the insert.
    return { observation: saved, replayed: false };
  });
}
