/** Original recurring terms for intervals absent from the paid lifecycle journal. */
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { proveOriginalConfiguredAuthority } from "../../lib/services/organization-schedule-target-authority";
import { assertOrganizationSubscription } from "../../lib/services/organization-subscription-source";
import { settlementDigest } from "../../lib/services/settlement-digest";
import { renewalUnavailable } from "../../lib/services/stripe-paid-renewal-validation";
import { resolveSubscriptionPlanDefinition } from "../../lib/services/subscription-catalog";
import {
  checkoutContractDigest,
  readCheckoutContract,
} from "../../lib/services/subscription-checkout-contract";
import {
  bindSubscriptionInvoiceEventEvidence,
  type SubscriptionInvoiceEventEvidence,
} from "../../lib/services/subscription-invoice-event-evidence";
import { proveReviewedPaidPlanBinding } from "../../lib/services/subscription-reviewed-plan-binding";
import type { Database, DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "../schemas/billing-subscriptions";
import { organizationPlanChangeQuotes } from "../schemas/organization-plan-change-quotes";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";

/** Caller selects an actual immutable commercial origin under receipt-owned evidence.
 * This establishes nominal terms, NOT paid lifecycle, current eligibility or financial authority.
 * Original provider invoice evidence supplies its real interval. No synthetic source revision,
 * paid target, current catalog fallback, grant, provider call or lifecycle write is made.
 */
export async function findOriginalInvoiceCommercialOrigin(
  retained: SubscriptionInvoiceEventEvidence,
  commandId: string,
  database: Database | DbTransaction = dbWrite,
) {
  const original = bindSubscriptionInvoiceEventEvidence(retained, retained.scope);
  const { scope } = original;
  const invoice = original.event.data.object,
    line = invoice.lines.data[0]!;
  const [owner] = await database
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.organization_id, scope.organizationId),
        eq(billingSubscriptions.id, scope.subscriptionId),
      ),
    );
  if (!owner) renewalUnavailable("original_commercial_owner_missing");
  assertOrganizationSubscription(owner);
  if (
    owner.provider !== "stripe" ||
    owner.stripe_customer_id !== scope.customerId ||
    owner.stripe_subscription_id !== scope.providerSubscriptionId ||
    owner.provider_environment !== (scope.livemode ? "live" : "test")
  )
    renewalUnavailable("original_commercial_owner_mismatch");
  const [purchase] = await database
    .select()
    .from(commands)
    .where(
      and(
        eq(commands.organization_id, scope.organizationId),
        eq(commands.id, scope.subscriptionId),
      ),
    );
  if (
    !purchase ||
    purchase.kind !== "checkout" ||
    purchase.status !== "APPLIED" ||
    purchase.result_subscription_id !== scope.subscriptionId ||
    purchase.subscription_id !== null ||
    purchase.app_id !== null ||
    purchase.billing_scope_id !== null ||
    purchase.merchant_key !== "platform"
  )
    renewalUnavailable("original_commercial_purchase_missing");
  const contract = readCheckoutContract(purchase);
  if (
    contract.accountId !== scope.providerAccountId ||
    contract.expectedLivemode !== scope.livemode ||
    contract.params.customer !== scope.customerId
  )
    renewalUnavailable("original_commercial_purchase_mismatch");
  const [command] =
    commandId === purchase.id
      ? [purchase]
      : await database
          .select()
          .from(commands)
          .where(
            and(
              eq(commands.organization_id, scope.organizationId),
              eq(commands.id, commandId),
              eq(commands.subscription_id, scope.subscriptionId),
            ),
          );
  if (
    !command ||
    command.status !== "APPLIED" ||
    command.result_subscription_id !== scope.subscriptionId ||
    command.app_id !== null ||
    command.billing_scope_id !== null ||
    command.merchant_key !== "platform" ||
    !["checkout", "upgrade", "downgrade"].includes(command.kind)
  )
    renewalUnavailable("original_commercial_origin_unavailable");
  const firstRevision = command.kind === "checkout" ? 1 : command.expected_subscription_revision;
  const lastRevision = command.kind === "checkout" ? 1 : command.result_subscription_revision;
  if (
    firstRevision === null ||
    lastRevision === null ||
    !Number.isSafeInteger(firstRevision) ||
    !Number.isSafeInteger(lastRevision) ||
    firstRevision < 1 ||
    lastRevision > owner.lifecycle_revision ||
    lastRevision !== firstRevision + (command.kind === "checkout" ? 0 : 1)
  )
    renewalUnavailable("original_commercial_origin_revision_invalid");
  const revisions = await database
    .select()
    .from(billingSubscriptionRevisions)
    .where(
      and(
        eq(billingSubscriptionRevisions.organization_id, scope.organizationId),
        eq(billingSubscriptionRevisions.subscription_id, scope.subscriptionId),
        gte(billingSubscriptionRevisions.revision, firstRevision),
        lte(billingSubscriptionRevisions.revision, lastRevision),
      ),
    )
    .orderBy(asc(billingSubscriptionRevisions.revision));
  if (revisions.length !== lastRevision - firstRevision + 1)
    renewalUnavailable("original_commercial_origin_revision_missing");
  for (const [index, row] of revisions.entries()) {
    assertOrganizationSubscription(row);
    if (
      row.revision !== firstRevision + index ||
      row.provider !== "stripe" ||
      row.provider_environment !== owner.provider_environment ||
      row.stripe_customer_id !== scope.customerId ||
      row.stripe_subscription_id !== scope.providerSubscriptionId ||
      row.stripe_subscription_item_id !== line.subscription_item ||
      row.quantity !== 1 ||
      row.catalog_version !== contract.catalogVersion
    )
      renewalUnavailable("original_commercial_origin_revision_mismatch");
  }
  const last = revisions.at(-1)!;
  const source = {
    ...owner,
    ...last,
    id: last.subscription_id,
    lifecycle_revision: last.revision,
    last_provider_event_id: last.provider_event_id,
    last_provider_event_created_at: last.provider_event_created_at,
  };
  let priceId = contract.priceId,
    productId = contract.productId,
    planKey = contract.planKey;
  let effectiveAt = last.current_period_end.getTime() / 1000;
  let quoteDigest: string | null = null;
  if (command.kind === "checkout") {
    if (
      last.source !== "checkout" ||
      last.plan_key !== contract.planKey ||
      last.pending_plan_key !== null
    )
      renewalUnavailable("original_commercial_checkout_revision_mismatch");
  } else {
    const quotes = await database
      .select()
      .from(organizationPlanChangeQuotes)
      .where(
        and(
          eq(organizationPlanChangeQuotes.organization_id, scope.organizationId),
          eq(organizationPlanChangeQuotes.subscription_id, scope.subscriptionId),
          eq(organizationPlanChangeQuotes.consumed_by_command_id, command.id),
        ),
      )
      .limit(2);
    const quote = quotes[0];
    if (
      quotes.length !== 1 ||
      !quote ||
      quote.subscription_revision !== firstRevision ||
      quote.target_plan_key !== command.target_plan_key ||
      quote.catalog_version !== last.catalog_version ||
      settlementDigest(quote.review) !== quote.review_digest
    )
      renewalUnavailable("original_commercial_review_missing");
    quoteDigest = settlementDigest({
      id: quote.id,
      review: quote.review,
      providerBinding: quote.provider_binding,
      sourceDigest: quote.source_digest,
      consumedByCommandId: quote.consumed_by_command_id,
    });
    if (command.kind === "upgrade") {
      const binding = proveReviewedPaidPlanBinding({ source, command, quote, revisions });
      priceId = binding.targetPriceId;
      productId = binding.targetProductId;
      assertOrganizationSubscription(source);
      planKey = source.plan_key;
    } else {
      if (
        quote.source_digest !==
          command.organization_schedule_configuration_evidence?.sourceDigest ||
        revisions[0]!.pending_plan_key !== null ||
        revisions[0]!.plan_key !== last.plan_key
      )
        renewalUnavailable("original_commercial_schedule_review_mismatch");
      const target = proveOriginalConfiguredAuthority({
        source,
        command,
        quoteId: quote.id,
        review: quote.review,
        providerBinding: quote.provider_binding,
      });
      priceId = target.binding.targetPriceId;
      productId = target.binding.targetProductId;
      planKey = target.targetPlanKey;
      effectiveAt = target.phase.start.getTime() / 1000;
    }
  }
  const plan = resolveSubscriptionPlanDefinition(planKey, contract.catalogVersion);
  if (
    line.price.id !== priceId ||
    line.price.product !== productId ||
    line.amount !== plan.amountCents ||
    invoice.currency !== plan.currency ||
    line.period.start < effectiveAt ||
    original.event.created < effectiveAt
  )
    renewalUnavailable("original_commercial_invoice_terms_mismatch");
  const body = {
    kind: "original_invoice_commercial_origin" as const,
    version: 1 as const,
    originalEvidenceDigest: original.digest,
    scope,
    commandId: command.id,
    originKind: command.kind,
    checkoutContractDigest: checkoutContractDigest(contract),
    originDigest: settlementDigest({
      commandId: command.id,
      kind: command.kind,
      providerResponseDigest: command.provider_response_digest,
      revisions,
      quoteDigest,
      configurationEvidence: command.organization_schedule_configuration_evidence,
      configurationSnapshot: command.organization_schedule_configuration_snapshot,
    }),
    planKey,
    catalogVersion: plan.catalogVersion,
    priceId,
    productId,
    effectiveAt,
    currency: plan.currency,
    baseAmountCents: plan.amountCents,
    allowanceAmountUsd: plan.allowance.amountUsd,
    subscriptionItemId: line.subscription_item,
    periodStart: line.period.start,
    periodEnd: line.period.end,
  };
  return { ...body, digest: settlementDigest(body) };
}
