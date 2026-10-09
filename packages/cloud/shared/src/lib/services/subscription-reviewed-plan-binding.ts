/** Resolves a paid upgrade's immutable catalog binding through its complete later source history. */
import type {
  BillingSubscription,
  BillingSubscriptionRevision,
} from "../../db/schemas/billing-subscriptions";
import type { organizationPlanChangeQuotes } from "../../db/schemas/organization-plan-change-quotes";
import type { BillingSubscriptionCommand } from "../../db/schemas/subscription-billing-operations";
import { organizationUpgradeReviewSchema } from "./organization-plan-change-contract";
import { organizationPlanChangeProviderBindingSchema } from "./organization-plan-change-provider-binding";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { settlementDigest } from "./settlement-digest";
import { renewalUnavailable } from "./stripe-paid-renewal-validation";
import { resolveSubscriptionPlanDefinition } from "./subscription-catalog";

function reject(): never {
  return renewalUnavailable("reviewed_paid_plan_binding_unverified");
}

export function proveReviewedPaidPlanBinding(input: {
  source: BillingSubscription;
  command: BillingSubscriptionCommand;
  quote: typeof organizationPlanChangeQuotes.$inferSelect;
  revisions: BillingSubscriptionRevision[];
}) {
  const { source, command, quote, revisions } = input;
  assertOrganizationSubscription(source);
  if (
    command.organization_id !== source.organization_id ||
    command.subscription_id !== source.id ||
    command.result_subscription_id !== source.id ||
    command.kind !== "upgrade" ||
    command.status !== "APPLIED" ||
    command.app_id !== null ||
    command.billing_scope_id !== null ||
    command.merchant_key !== "platform" ||
    command.target_plan_key !== source.plan_key ||
    command.expected_subscription_revision === null ||
    !Number.isSafeInteger(command.expected_subscription_revision) ||
    command.expected_subscription_revision < 1 ||
    !Number.isSafeInteger(source.lifecycle_revision) ||
    command.result_subscription_revision !== command.expected_subscription_revision + 1 ||
    command.result_subscription_revision > source.lifecycle_revision ||
    quote.organization_id !== source.organization_id ||
    quote.subscription_id !== source.id ||
    quote.consumed_by_command_id !== command.id ||
    quote.subscription_revision !== command.expected_subscription_revision ||
    quote.target_plan_key !== source.plan_key ||
    quote.catalog_version !== source.catalog_version
  )
    reject();
  const parsed = organizationUpgradeReviewSchema.safeParse(quote.review),
    bound = organizationPlanChangeProviderBindingSchema.safeParse(quote.provider_binding);
  if (!parsed.success || !bound.success) reject();
  const review = parsed.data,
    binding = bound.data;
  if (
    settlementDigest(review) !== quote.review_digest ||
    review.subscriptionId !== source.id ||
    review.expectedSubscriptionRevision !== String(command.expected_subscription_revision) ||
    review.targetPlanKey !== source.plan_key ||
    review.catalogVersion !== source.catalog_version ||
    binding.livemode !== (source.provider_environment === "live")
  )
    reject();
  const previous = revisions[0],
    paid = revisions[1],
    last = revisions.at(-1);
  if (
    !previous ||
    !paid ||
    !last ||
    revisions.length !== source.lifecycle_revision - command.expected_subscription_revision! + 1 ||
    previous.revision !== command.expected_subscription_revision ||
    paid.revision !== command.result_subscription_revision ||
    last.revision !== source.lifecycle_revision ||
    previous.plan_key !== review.sourcePlanKey ||
    previous.pending_plan_key !== null ||
    paid.pending_plan_key !== null ||
    paid.status !== "active" ||
    paid.cancel_at_period_end ||
    paid.ended_at !== null ||
    paid.dunning_started_at !== null ||
    paid.grace_expires_at !== null ||
    Date.parse(review.currentPeriodStart) !== previous.current_period_start.getTime() ||
    Date.parse(review.currentPeriodEnd) !== previous.current_period_end.getTime() ||
    previous.current_period_start.getTime() !== paid.current_period_start.getTime() ||
    previous.current_period_end.getTime() !== paid.current_period_end.getTime()
  )
    reject();
  const target = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
  if (
    target.amountCents <=
      resolveSubscriptionPlanDefinition(review.sourcePlanKey, source.catalog_version).amountCents ||
    target.amountCents !== review.targetBaseAmountCents ||
    target.allowance.amountUsd !== review.targetAllowanceUsd
  )
    reject();
  for (const [index, row] of revisions.entries()) {
    if (
      row.revision !== command.expected_subscription_revision! + index ||
      row.organization_id !== source.organization_id ||
      row.subscription_id !== source.id ||
      row.billing_scope_id !== null ||
      row.merchant_key !== "platform" ||
      row.provider !== "stripe" ||
      row.provider_environment !== source.provider_environment ||
      row.stripe_customer_id !== source.stripe_customer_id ||
      row.stripe_subscription_id !== source.stripe_subscription_id ||
      row.stripe_subscription_item_id !== source.stripe_subscription_item_id ||
      row.catalog_version !== source.catalog_version ||
      row.quantity !== source.quantity ||
      (index > 0 && row.plan_key !== source.plan_key)
    )
      reject();
  }
  // The source passed across provider I/O must be the same immutable revision rechecked at publication.
  for (const key of [
    "plan_key",
    "pending_plan_key",
    "status",
    "provider_object_digest",
    "cancel_at_period_end",
    "quantity",
  ] as const)
    if (last[key] !== source[key]) reject();
  for (const key of [
    "current_period_start",
    "current_period_end",
    "canceled_at",
    "ended_at",
    "dunning_started_at",
    "grace_expires_at",
  ] as const)
    if (last[key]?.getTime() !== source[key]?.getTime()) reject();
  return binding;
}
