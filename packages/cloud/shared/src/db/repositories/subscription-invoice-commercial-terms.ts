/** Resolves original terms from a named immutable revision, never today's plan or prices. */
import { and, eq } from "drizzle-orm";
import { assertOrganizationSubscription } from "../../lib/services/organization-subscription-source";
import { settlementDigest } from "../../lib/services/settlement-digest";
import { renewalUnavailable } from "../../lib/services/stripe-paid-renewal-validation";
import { resolveSubscriptionPlanDefinition } from "../../lib/services/subscription-catalog";
import { checkoutContractDigest } from "../../lib/services/subscription-checkout-contract";
import {
  bindSubscriptionInvoiceEventEvidence,
  type SubscriptionInvoiceEventEvidence,
} from "../../lib/services/subscription-invoice-event-evidence";
import type { Database, DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "../schemas/billing-subscriptions";
import { findSubscriptionRenewalBinding } from "./subscription-purchased-binding";

/** Private evidence resolver, not collection proof or authorization to grant allowance.
 * The caller supplies a receipt-owned original and its explicitly selected recorded revision.
 * Missing original-period revisions remain unavailable; this does not fabricate one for a
 * deferred period the lifecycle has never recorded. Publication must independently lock/recheck
 * the receipt, observation and all contributing owners/fences and preserve original expiry.
 */
export async function findOriginalInvoiceCommercialTerms(
  retained: SubscriptionInvoiceEventEvidence,
  subscriptionRevision: number,
  database: Database | DbTransaction = dbWrite,
) {
  const original = bindSubscriptionInvoiceEventEvidence(retained, retained.scope);
  if (!Number.isSafeInteger(subscriptionRevision) || subscriptionRevision < 1)
    renewalUnavailable("original_commercial_revision_invalid");
  const { scope } = original;
  const [current] = await database
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.organization_id, scope.organizationId),
        eq(billingSubscriptions.id, scope.subscriptionId),
      ),
    );
  const [revision] = await database
    .select()
    .from(billingSubscriptionRevisions)
    .where(
      and(
        eq(billingSubscriptionRevisions.organization_id, scope.organizationId),
        eq(billingSubscriptionRevisions.subscription_id, scope.subscriptionId),
        eq(billingSubscriptionRevisions.revision, subscriptionRevision),
      ),
    );
  const invoice = original.event.data.object;
  const line = invoice.lines.data[0]!;
  if (
    !current ||
    !revision ||
    revision.revision > current.lifecycle_revision ||
    revision.provider !== "stripe" ||
    revision.provider_environment !== (scope.livemode ? "live" : "test") ||
    revision.stripe_customer_id !== scope.customerId ||
    revision.stripe_subscription_id !== scope.providerSubscriptionId ||
    revision.stripe_subscription_item_id !== line.subscription_item ||
    revision.quantity !== line.quantity ||
    revision.current_period_start.getTime() !== line.period.start * 1000 ||
    revision.current_period_end.getTime() !== line.period.end * 1000
  )
    renewalUnavailable("original_commercial_revision_mismatch");
  // Project actual saved fields, as funded replay does. No lifecycle row is written or
  // historical period synthesized. Current status/plan are irrelevant to these original terms.
  const source = {
    ...current,
    ...revision,
    id: revision.subscription_id,
    lifecycle_revision: revision.revision,
    last_provider_event_id: revision.provider_event_id,
    last_provider_event_created_at: revision.provider_event_created_at,
  };
  assertOrganizationSubscription(source);
  const binding = await findSubscriptionRenewalBinding(source, {}, database);
  const { contract } = binding;
  if (!contract || contract.accountId !== scope.providerAccountId)
    renewalUnavailable("original_commercial_purchase_missing");
  const plan = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
  const priceId =
    plan.key === "plus_monthly"
      ? binding.environment.STRIPE_PLUS_MONTHLY_PRICE_ID
      : binding.environment.STRIPE_PRO_MONTHLY_PRICE_ID;
  const productId =
    plan.key === "plus_monthly"
      ? binding.environment.STRIPE_PLUS_PRODUCT_ID
      : binding.environment.STRIPE_PRO_PRODUCT_ID;
  if (
    priceId !== line.price.id ||
    productId !== line.price.product ||
    line.amount !== plan.amountCents ||
    invoice.currency !== plan.currency
  )
    renewalUnavailable("original_commercial_terms_mismatch");
  const body = {
    kind: "original_invoice_commercial_terms" as const,
    version: 1 as const,
    originalEvidenceDigest: original.digest,
    scope,
    revisionId: revision.id,
    subscriptionRevision: revision.revision,
    revisionDigest: settlementDigest(revision),
    checkoutContractDigest: checkoutContractDigest(contract),
    planKey: plan.key,
    catalogVersion: plan.catalogVersion,
    priceId,
    productId,
    currency: plan.currency,
    baseAmountCents: plan.amountCents,
    allowanceAmountUsd: plan.allowance.amountUsd,
    periodStart: line.period.start,
    periodEnd: line.period.end,
  };
  return { ...body, digest: settlementDigest(body) };
}
