/** Internal proof bound to the original database-owned review; no publication or allowance mutation. */
import { ElizaError } from "@elizaos/core";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { organizationDowngradeReviewSchema } from "./organization-downgrade-review";
import { organizationPlanChangeProviderBindingSchema } from "./organization-plan-change-provider-binding";
import {
  proveOrganizationScheduleConfiguration,
  proveOriginalOrganizationScheduleConfiguration,
} from "./organization-schedule-configuration-proof";
import { organizationScheduleEffectRequestSchema } from "./organization-schedule-effect-contract";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { settlementDigest } from "./settlement-digest";
import { resolveSubscriptionPlanDefinition } from "./subscription-catalog";

type Source = Pick<
  BillingSubscription,
  | "id"
  | "lifecycle_revision"
  | "billing_scope_id"
  | "merchant_key"
  | "provider"
  | "provider_environment"
  | "stripe_customer_id"
  | "stripe_subscription_id"
  | "stripe_subscription_item_id"
  | "plan_key"
  | "pending_plan_key"
  | "catalog_version"
  | "status"
  | "current_period_start"
  | "current_period_end"
  | "cancel_at_period_end"
  | "canceled_at"
  | "ended_at"
  | "dunning_started_at"
  | "grace_expires_at"
>;
function reject(reason: string): never {
  throw new ElizaError("Configured schedule is not the original reviewed lower plan", {
    code: "SUBSCRIPTION_SCHEDULE_REVIEW_UNVERIFIED",
    context: { reason },
  });
}
/** Call only with locked original review/binding/source and authenticated raw observations.
 * The configuration dispatch must have occurred inside the original quote validity window;
 * historical evidence can be recovered later; current publication adds separate live checks.
 */
export function proveOriginalReviewedOrganizationScheduleConfiguration(
  input: Parameters<typeof proveOriginalOrganizationScheduleConfiguration>[0] & {
    source: Source;
    review: unknown;
    providerBinding: unknown;
  },
) {
  const { source } = input;
  assertOrganizationSubscription(source);
  const review = organizationDowngradeReviewSchema.parse(input.review);
  const binding = organizationPlanChangeProviderBindingSchema.parse(input.providerBinding);
  const request = organizationScheduleEffectRequestSchema.parse(
    input.originalConfiguration.originalRequest.request,
  );
  const original = input.originalTerms.subscription;
  const item = original.items.data[0];
  const observed = input.originalConfiguration.observedAt.getTime();
  const dispatched = input.originalConfiguration.originalRequest.startedAt.getTime();
  const start = source.current_period_start?.getTime();
  const end = source.current_period_end?.getTime();
  if (
    source.provider !== "stripe" ||
    source.status !== "active" ||
    source.cancel_at_period_end ||
    source.canceled_at !== null ||
    source.ended_at !== null ||
    source.dunning_started_at !== null ||
    source.grace_expires_at !== null ||
    source.pending_plan_key !== null ||
    start === undefined ||
    end === undefined ||
    !Number.isSafeInteger(observed) ||
    start > observed
  )
    reject("original_active_period_required");
  if (
    review.subscriptionId !== source.id ||
    review.expectedSubscriptionRevision !== String(source.lifecycle_revision) ||
    review.sourcePlanKey !== source.plan_key ||
    review.catalogVersion !== source.catalog_version ||
    Date.parse(review.currentPeriodStart) !== start ||
    Date.parse(review.currentPeriodEnd) !== end ||
    Date.parse(review.effectiveAt) !== end
  )
    reject("review_source_changed");
  if (
    !Number.isSafeInteger(dispatched) ||
    dispatched < start ||
    dispatched >= end ||
    dispatched < Date.parse(review.observedAt) ||
    dispatched >= Date.parse(review.expiresAt) ||
    dispatched > observed
  )
    reject("configuration_outside_original_review");
  const previous = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
  const target = resolveSubscriptionPlanDefinition(review.targetPlanKey, source.catalog_version);
  if (
    target.amountCents >= previous.amountCents ||
    review.targetBaseAmountCents !== target.amountCents ||
    review.targetAllowanceUsd !== target.allowance.amountUsd
  )
    reject("reviewed_lower_catalog_required");
  if (
    request.kind !== "schedule_configure" ||
    request.params.phases[0].items[0]?.price !== binding.sourcePriceId ||
    request.params.phases[1].items[0]?.price !== binding.targetPriceId ||
    original.id !== source.stripe_subscription_id ||
    original.customer !== source.stripe_customer_id ||
    original.current_period_start * 1000 !== start ||
    original.current_period_end * 1000 !== end ||
    binding.livemode !== (source.provider_environment === "live") ||
    original.livemode !== binding.livemode ||
    item?.id !== source.stripe_subscription_item_id ||
    item.price.id !== binding.sourcePriceId ||
    item.price.product !== binding.sourceProductId ||
    item.price.unit_amount !== previous.amountCents
  )
    reject("original_provider_binding_changed");
  const proof = proveOriginalOrganizationScheduleConfiguration(input);
  if (proof.effectiveAt * 1000 !== end) reject("effective_boundary_changed");
  return {
    ...proof,
    targetPlanKey: target.key,
    retainedTermsDigest: settlementDigest(input.originalTerms),
    reviewDigest: settlementDigest(review),
    providerBindingDigest: settlementDigest(binding),
  };
}

/** Current-period publication keeps its independent fresh live-state proof. */
export function proveReviewedOrganizationScheduleConfiguration(
  input: Parameters<typeof proveOrganizationScheduleConfiguration>[0] & {
    source: Source;
    review: unknown;
    providerBinding: unknown;
  },
) {
  const { configuredSnapshot: _originalSnapshot, ...original } =
    proveOriginalReviewedOrganizationScheduleConfiguration(input);
  if (
    input.source.current_period_end === null ||
    input.originalConfiguration.observedAt >= input.source.current_period_end
  )
    reject("original_active_period_required");
  const current = proveOrganizationScheduleConfiguration(input);
  if (current.snapshotDigest !== original.snapshotDigest) reject("original_snapshot_changed");
  return original;
}
