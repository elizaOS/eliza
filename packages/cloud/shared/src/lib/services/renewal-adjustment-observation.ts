/** Reads subsequent adjustments under original retained grant authority; never publishes allowance. */
import { ElizaError } from "@elizaos/core";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import {
  bindRenewalInvoiceAuthority,
  type RenewalInvoiceAuthority,
} from "./renewal-invoice-authority";
import { bindRenewalInvoiceDetails } from "./renewal-invoice-details";
import { bindRenewalSettlementDetails } from "./renewal-settlement-details";
import { settlementDigest } from "./settlement-digest";
import { retrieveInvoiceCreditNoteDispositions } from "./stripe-credit-note-dispositions";

function unavailable(): never {
  throw new ElizaError("Adjustment observation requires retained original grant and settlement", {
    code: "SUBSCRIPTION_ADJUSTMENT_ORIGINAL_REQUIRED",
  });
}
/** source must be the original paid source revision loaded with the immutable grant,
 * not the current subscription or renderer input. Caller owns authentication and database
 * revalidation/publication. Legacy missing evidence is not reconstructed from Stripe. */
export async function observeRetainedRenewalAdjustments(
  input: {
    source: BillingSubscription;
    invoiceId: string;
    grantDigest: string;
    metadata: Record<string, unknown>;
  },
  stripe: Parameters<typeof retrieveInvoiceCreditNoteDispositions>[1],
) {
  const authority = bindRenewalInvoiceAuthority(
    input.metadata.renewalInvoiceAuthority as RenewalInvoiceAuthority,
    input.source,
    input.invoiceId,
    input.grantDigest,
  );
  const invoiceDetails = bindRenewalInvoiceDetails(input.metadata.renewalInvoiceDetails, authority);
  const settlement = bindRenewalSettlementDetails(
    input.metadata.renewalSettlementDetails,
    invoiceDetails,
    authority,
  );
  if (!authority.providerAccountId) unavailable();
  const observation = await retrieveInvoiceCreditNoteDispositions(
    {
      providerAccountId: authority.providerAccountId,
      invoiceId: authority.invoiceId,
      customerId: authority.customerId,
      livemode: authority.livemode,
      currency: authority.currency,
      invoiceLineIds: [authority.invoiceLineId],
    },
    stripe,
  );
  const current = observation.noteObservation.invoice,
    original = invoiceDetails.invoice;
  if (
    current.total !== original.total ||
    current.amount_paid !== original.amount_paid ||
    current.amount_due !== original.amount_due ||
    current.amount_remaining !== 0 ||
    current.status !== "paid" ||
    current.starting_balance !== original.starting_balance ||
    current.ending_balance !== original.ending_balance ||
    current.pre_payment_credit_notes_amount !== original.pre_payment_credit_notes_amount ||
    observation.invoice.payment_intent !== original.payment_intent ||
    observation.invoice.charge !== original.charge ||
    (observation.payment &&
      (observation.payment.id !== settlement.payment?.id ||
        observation.payment.amount_received !== settlement.payment.amount_received)) ||
    (observation.charge &&
      (observation.charge.id !== settlement.charge?.id ||
        observation.charge.amount_captured !== settlement.charge.amount_captured))
  )
    unavailable();
  const body = {
    kind: "renewal_adjustment_observation" as const,
    version: 1 as const,
    organizationId: authority.organizationId,
    subscriptionId: authority.subscriptionId,
    invoiceAuthorityDigest: authority.digest,
    invoiceDetailsDigest: invoiceDetails.digest,
    settlementDetailsDigest: settlement.digest,
    grantDigest: authority.grantDigest,
    observation,
  };
  return { ...body, digest: settlementDigest(body) };
}
