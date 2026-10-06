/** Verifies applied target state against immutable reviewed identities. No entitlement or allowance writes. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { type BillingSubscription } from "../../db/schemas/billing-subscriptions";
import {
  type OrganizationUpgradeReview,
  organizationUpgradeReviewSchema,
} from "./organization-plan-change-contract";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import {
  type OrganizationUpgradeProviderBinding,
  organizationUpgradeProviderBindingSchema,
} from "./organization-upgrade-provider-binding";
import { settlementDigest } from "./settlement-digest";
import { organizationSubscriptionObservationSchema as observationSchema } from "./stripe-organization-subscription-observation";
import { resolveSubscriptionPlanDefinition } from "./subscription-catalog";

function reject(reason: string): never {
  throw new ElizaError("Upgrade target subscription is not confirmed", {
    code: "SUBSCRIPTION_UPGRADE_TARGET_UNVERIFIED",
    context: { reason },
  });
}
export type OrganizationUpgradeSource = Omit<
  BillingSubscription,
  "created_at" | "updated_at" | "last_provider_event_id" | "last_provider_event_created_at"
>;
export function observeAppliedOrganizationUpgrade(input: {
  source: OrganizationUpgradeSource;
  review: OrganizationUpgradeReview;
  binding: OrganizationUpgradeProviderBinding;
  raw: unknown;
  observedAt: Date;
}) {
  const { source } = input;
  assertOrganizationSubscription(source);
  const review = organizationUpgradeReviewSchema.parse(input.review),
    binding = organizationUpgradeProviderBindingSchema.parse(input.binding);
  const target = resolveSubscriptionPlanDefinition(review.targetPlanKey, review.catalogVersion);
  const parsed = observationSchema
    .extend({ collection_method: z.literal("charge_automatically") })
    .safeParse(input.raw);
  if (!parsed.success) reject("incomplete_or_pending_target");
  const wire = parsed.data,
    item = wire.items.data[0]!;
  if (
    !Number.isFinite(input.observedAt.getTime()) ||
    source.status !== "active" ||
    source.provider !== "stripe" ||
    source.cancel_at_period_end ||
    source.pending_plan_key !== null ||
    source.ended_at !== null ||
    source.dunning_started_at !== null ||
    source.grace_expires_at !== null ||
    review.subscriptionId !== source.id ||
    review.expectedSubscriptionRevision !== String(source.lifecycle_revision) ||
    review.sourcePlanKey !== source.plan_key ||
    review.catalogVersion !== source.catalog_version ||
    review.currentPeriodStart !== source.current_period_start?.toISOString() ||
    review.currentPeriodEnd !== source.current_period_end?.toISOString() ||
    target.amountCents <=
      resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version).amountCents ||
    target.amountCents !== review.targetBaseAmountCents ||
    target.allowance.amountUsd !== review.targetAllowanceUsd ||
    binding.livemode !== (source.provider_environment === "live") ||
    wire.id !== source.stripe_subscription_id ||
    wire.customer !== source.stripe_customer_id ||
    wire.livemode !== binding.livemode ||
    item.id !== source.stripe_subscription_item_id ||
    item.price.id !== binding.targetPriceId ||
    item.price.product !== binding.targetProductId ||
    item.price.livemode !== binding.livemode ||
    item.price.unit_amount !== target.amountCents ||
    wire.current_period_start * 1000 !== source.current_period_start?.getTime() ||
    wire.current_period_end * 1000 !== source.current_period_end?.getTime() ||
    wire.cancel_at_period_end ||
    wire.cancel_at !== null ||
    (wire.canceled_at !== null && wire.canceled_at * 1000 !== source.canceled_at?.getTime()) ||
    (wire.trial_end !== null && wire.trial_end * 1000 > input.observedAt.getTime())
  )
    reject("target_identity_terms_or_period_changed");
  return {
    values: {
      provider: source.provider,
      provider_environment: source.provider_environment,
      stripe_customer_id: source.stripe_customer_id,
      stripe_subscription_id: source.stripe_subscription_id,
      stripe_subscription_item_id: source.stripe_subscription_item_id,
      catalog_version: source.catalog_version,
      plan_key: review.targetPlanKey,
      status: "active" as const,
      current_period_start: source.current_period_start,
      current_period_end: source.current_period_end,
      cancel_at_period_end: false,
      canceled_at: wire.canceled_at === null ? null : new Date(wire.canceled_at * 1000),
      ended_at: null,
      dunning_started_at: null,
      grace_expires_at: null,
      pending_plan_key: null,
      provider_object_digest: settlementDigest(wire),
    },
    reviewDigest: settlementDigest(review),
    bindingDigest: settlementDigest(binding),
  };
}
