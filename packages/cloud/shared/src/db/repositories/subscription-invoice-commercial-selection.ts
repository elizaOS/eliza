/** Receipt-owned nominal-term selection; never allowance publication or provider I/O. */
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { organizationPlanChangeProviderBindingSchema } from "../../lib/services/organization-plan-change-provider-binding";
import { settlementDigest } from "../../lib/services/settlement-digest";
import { readCheckoutContract } from "../../lib/services/subscription-checkout-contract";
import { bindSubscriptionInvoiceEventEvidence } from "../../lib/services/subscription-invoice-event-evidence";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import { billingSubscriptionRevisions as revisions } from "../schemas/billing-subscriptions";
import { organizationPlanChangeQuotes as quotes } from "../schemas/organization-plan-change-quotes";
import { organizations } from "../schemas/organizations";
import {
  billingSubscriptionCommands as commands,
  subscriptionInvoiceEventEvidence as originals,
  billingSubscriptionEventReceipts as receipts,
} from "../schemas/subscription-billing-operations";
import { findOriginalInvoiceCommercialOrigin } from "./subscription-invoice-commercial-origin";
import { loadOriginalInvoiceContributors } from "./subscription-invoice-contributors";

const request = z
  .object({ organizationId: z.string().uuid(), receiptId: z.string().uuid() })
  .strict();
// Explicit resource bound: a partial command history can never authorize a selection.
const MAX_ORIGINS = 1_000;
function unavailable(reason: string): never {
  throw new ElizaError("Original invoice commercial selection is unavailable", {
    code: "SUBSCRIPTION_INVOICE_COMMERCIAL_SELECTION_UNAVAILABLE",
    context: { reason },
  });
}

/** Compare only already-proven origins; agreement does not validate an origin. */
export function agreeOriginalInvoiceCommercialTerms(
  matches: readonly Awaited<ReturnType<typeof findOriginalInvoiceCommercialOrigin>>[],
) {
  if (!matches.length) unavailable("matching_origin_missing");
  const nominal = (row: Awaited<ReturnType<typeof findOriginalInvoiceCommercialOrigin>>) => ({
    planKey: row.planKey,
    catalogVersion: row.catalogVersion,
    priceId: row.priceId,
    productId: row.productId,
    currency: row.currency,
    baseAmountCents: row.baseAmountCents,
    allowanceAmountUsd: row.allowanceAmountUsd,
    subscriptionItemId: row.subscriptionItemId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
  });
  const terms = nominal(matches[0]!);
  if (matches.some((row) => settlementDigest(nominal(row)) !== settlementDigest(terms)))
    unavailable("matching_terms_conflict");
  return terms;
}

/** Internal caller owns authentication. The stored receipt supplies all provider identity.
 * Result is a point-in-time nominal-term observation, not a durable authorization token.
 * Financial publication must reselect under its transaction and recheck the associated
 * observation, policy, collection and contributor restrictions; this writes no state.
 */
export async function readOriginalInvoiceCommercialSelection(
  value: z.infer<typeof request>,
  transaction?: DbTransaction,
) {
  const parsed = request.safeParse(value);
  if (!parsed.success) unavailable("invalid_request");
  const input = parsed.data;
  const read = async (tx: DbTransaction) => {
    const [org] = await tx
      .select({
        active: organizations.is_active,
        state: organizations.account_lifecycle_state,
        deletion: organizations.account_deletion_request_id,
        fenced: organizations.paid_work_fenced_at,
      })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!org || !org.active || org.state !== "active" || org.deletion || org.fenced)
      unavailable("organization_unavailable");
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
      receipt.event_type !== "invoice.paid" ||
      receipt.provider_object_type !== "invoice"
    )
      unavailable("receipt_unavailable");
    const [stored] = await tx
      .select()
      .from(originals)
      .where(
        and(
          eq(originals.receipt_id, receipt.id),
          eq(originals.organization_id, input.organizationId),
        ),
      );
    if (!stored) unavailable("original_missing");
    const original = bindSubscriptionInvoiceEventEvidence(stored.evidence, {
      ...stored.evidence.scope,
      organizationId: receipt.organization_id,
      subscriptionId: receipt.subscription_id,
      providerEventId: receipt.provider_event_id,
      invoiceId: receipt.provider_object_id,
      livemode: receipt.livemode,
    });
    const contributors = await loadOriginalInvoiceContributors(tx, original, [
      original.scope.invoiceId,
    ]);
    const contributor = contributors.find((row) => row.receiptId === receipt.id);
    if (!contributor || contributor.evidence.digest !== original.digest)
      unavailable("original_owner_changed");
    const line = original.event.data.object.lines.data[0]!;
    const history = await tx
      .select({ command: commands, quote: quotes, revision: revisions })
      .from(commands)
      .leftJoin(
        quotes,
        and(
          eq(quotes.organization_id, commands.organization_id),
          eq(quotes.consumed_by_command_id, commands.id),
        ),
      )
      .leftJoin(
        revisions,
        and(
          eq(revisions.organization_id, commands.organization_id),
          eq(revisions.subscription_id, receipt.subscription_id),
          sql`${revisions.revision} = CASE WHEN ${commands.kind}='checkout' THEN 1 ELSE ${commands.result_subscription_revision} END`,
        ),
      )
      .where(
        and(
          eq(commands.organization_id, input.organizationId),
          eq(commands.status, "APPLIED"),
          isNull(commands.app_id),
          isNull(commands.billing_scope_id),
          eq(commands.merchant_key, "platform"),
          or(
            and(eq(commands.kind, "checkout"), eq(commands.id, receipt.subscription_id)),
            and(
              inArray(commands.kind, ["upgrade", "downgrade"]),
              eq(commands.subscription_id, receipt.subscription_id),
            ),
          ),
        ),
      )
      .orderBy(asc(commands.id))
      .limit(MAX_ORIGINS + 1);
    if (!history.length || history.length > MAX_ORIGINS) unavailable("origin_history_unavailable");
    if (new Set(history.map((row) => row.command.id)).size !== history.length)
      unavailable("origin_history_ambiguous");
    const matches: Awaited<ReturnType<typeof findOriginalInvoiceCommercialOrigin>>[] = [];
    for (const { command, quote, revision } of history) {
      if (!revision) unavailable("origin_revision_missing");
      // All supported origins begin recurring terms at the recorded original period end.
      // This is an immutable applicability boundary, not the time we happened to reconcile it.
      if (revision.current_period_end.getTime() > line.period.start * 1000) continue;
      let priceId: string;
      if (command.kind === "checkout") priceId = readCheckoutContract(command).priceId;
      else {
        if (!quote) unavailable("origin_review_missing");
        const binding = organizationPlanChangeProviderBindingSchema.safeParse(
          quote.provider_binding,
        );
        if (!binding.success) unavailable("origin_binding_missing");
        priceId = binding.data.targetPriceId;
      }
      if (priceId !== line.price.id) continue;
      matches.push(await findOriginalInvoiceCommercialOrigin(original, command.id, tx));
    }
    const terms = agreeOriginalInvoiceCommercialTerms(matches);
    const body = {
      kind: "original_invoice_commercial_selection" as const,
      version: 1 as const,
      organizationId: input.organizationId,
      receiptId: receipt.id,
      originalEvidenceDigest: original.digest,
      scope: original.scope,
      fence: contributor.fence,
      terms,
      origins: matches,
    };
    return { ...body, digest: settlementDigest(body) };
  };
  return transaction ? read(transaction) : writeTransaction(read);
}
