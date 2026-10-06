/** Reads an already-funded invoice through immutable source and grant records; never restores spendable allowance. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { assertOrganizationSubscription } from "../../lib/services/organization-subscription-source";
import type { RenewalInvoiceAuthority } from "../../lib/services/renewal-invoice-authority";
import type { RenewalInvoiceDetails } from "../../lib/services/renewal-invoice-details";
import type { RenewalSettlementDetails } from "../../lib/services/renewal-settlement-details";
import { renewalUnavailable } from "../../lib/services/stripe-paid-renewal-validation";
import type { DbTransaction } from "../client";
import {
  type BillingSubscription,
  billingSubscriptionRevisions,
} from "../schemas/billing-subscriptions";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions } from "../schemas/subscription-allowance-transactions";
import { subscriptionAllowanceRepository } from "./subscription-allowance";

const invoiceIdentity = z.object({
  object: z.literal("invoice"),
  id: z.string(),
  customer: z.string(),
  subscription: z.string(),
  livemode: z.boolean(),
  billing_reason: z.literal("subscription_cycle"),
});
export async function replayFundedRenewalInTransaction(
  tx: DbTransaction,
  input: {
    source: BillingSubscription;
    invoiceId: string;
    invoice: unknown;
    databaseNow: Date;
  },
) {
  const { source } = input;
  assertOrganizationSubscription(source);
  const [period] = await tx
    .select()
    .from(subscriptionAllowancePeriods)
    .where(
      and(
        eq(subscriptionAllowancePeriods.provider, source.provider),
        eq(subscriptionAllowancePeriods.provider_environment, source.provider_environment),
        eq(subscriptionAllowancePeriods.stripe_invoice_id, input.invoiceId),
      ),
    )
    .for("update");
  if (!period) return null;
  const invoice = invoiceIdentity.safeParse(input.invoice);
  if (
    !invoice.success ||
    invoice.data.id !== input.invoiceId ||
    invoice.data.customer !== source.stripe_customer_id ||
    invoice.data.subscription !== source.stripe_subscription_id ||
    invoice.data.livemode !== (source.provider_environment === "live") ||
    period.organization_id !== source.organization_id ||
    period.subscription_id !== source.id ||
    period.billing_scope_id !== null ||
    period.merchant_key !== "platform" ||
    period.grant_source !== "paid_invoice" ||
    period.subscription_revision > source.lifecycle_revision
  )
    renewalUnavailable("funded_invoice_identity_mismatch");
  const [revision] = await tx
    .select()
    .from(billingSubscriptionRevisions)
    .where(
      and(
        eq(billingSubscriptionRevisions.organization_id, source.organization_id),
        eq(billingSubscriptionRevisions.subscription_id, source.id),
        eq(billingSubscriptionRevisions.revision, period.subscription_revision),
      ),
    );
  const [grant] = await tx
    .select()
    .from(subscriptionAllowanceTransactions)
    .where(
      and(
        eq(subscriptionAllowanceTransactions.organization_id, source.organization_id),
        eq(subscriptionAllowanceTransactions.allowance_period_id, period.id),
        eq(subscriptionAllowanceTransactions.kind, "grant"),
      ),
    );
  if (
    !revision ||
    !grant ||
    revision.provider !== source.provider ||
    revision.provider_environment !== source.provider_environment ||
    revision.stripe_customer_id !== source.stripe_customer_id ||
    revision.stripe_subscription_id !== source.stripe_subscription_id ||
    grant.billing_scope_id !== null ||
    grant.merchant_key !== "platform"
  )
    renewalUnavailable("funded_invoice_authority_missing");
  // Project the actual immutable paid revision, never the current plan or a fabricated provider state.
  const result = await subscriptionAllowanceRepository.grantRenewalInTransaction(tx, {
    source: {
      ...source,
      ...revision,
      id: revision.subscription_id,
      lifecycle_revision: revision.revision,
    },
    invoiceId: input.invoiceId,
    requestDigest: grant.request_digest,
    ...(grant.metadata.renewalInvoiceAuthority !== undefined
      ? { invoiceAuthority: grant.metadata.renewalInvoiceAuthority as RenewalInvoiceAuthority }
      : {}),
    ...(grant.metadata.renewalInvoiceDetails !== undefined
      ? { invoiceDetails: grant.metadata.renewalInvoiceDetails as RenewalInvoiceDetails }
      : {}),
    ...(grant.metadata.renewalSettlementDetails !== undefined
      ? { settlementDetails: grant.metadata.renewalSettlementDetails as RenewalSettlementDetails }
      : {}),
    databaseNow: input.databaseNow,
  });
  if (!result.replayed) renewalUnavailable("funded_invoice_replay_required");
  return { replayed: true, subscriptionRevision: revision.revision };
}
