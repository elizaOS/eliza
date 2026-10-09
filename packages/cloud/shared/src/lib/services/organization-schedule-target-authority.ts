/** Pure binding of immutable original command evidence; caller must supply locked database-owned records. */
import { ElizaError } from "@elizaos/core";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import type { BillingSubscriptionCommand } from "../../db/schemas/subscription-billing-operations";
import { organizationDowngradeReviewSchema } from "./organization-downgrade-review";
import { organizationPlanChangeProviderBindingSchema } from "./organization-plan-change-provider-binding";
import { proveRetainedScheduleTargetLifecycle } from "./organization-schedule-target-lifecycle";
import { readRetainedScheduleTarget } from "./organization-schedule-target-phase";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { settlementDigest } from "./settlement-digest";
import { resolveSubscriptionPlanDefinition } from "./subscription-catalog";

function reject(reason: string): never {
  throw new ElizaError("Original scheduled target authority is unavailable", {
    code: "SUBSCRIPTION_SCHEDULE_TARGET_UNVERIFIED",
    context: { reason },
  });
}
type Source = Pick<
  BillingSubscription,
  | "id"
  | "organization_id"
  | "lifecycle_revision"
  | "billing_scope_id"
  | "merchant_key"
  | "provider"
  | "provider_environment"
  | "stripe_customer_id"
  | "stripe_subscription_id"
  | "plan_key"
  | "pending_plan_key"
  | "catalog_version"
  | "status"
  | "current_period_start"
  | "current_period_end"
  | "provider_object_digest"
>;
type Command = Pick<
  BillingSubscriptionCommand,
  | "id"
  | "organization_id"
  | "subscription_id"
  | "app_id"
  | "billing_scope_id"
  | "merchant_key"
  | "kind"
  | "status"
  | "target_plan_key"
  | "expected_subscription_revision"
  | "result_subscription_id"
  | "result_subscription_revision"
  | "provider_response_digest"
  | "organization_schedule_configuration_evidence"
  | "organization_schedule_configuration_snapshot"
>;
export function proveOriginalConfiguredAuthority(input: {
  source: Source;
  command: Command;
  quoteId: string;
  review: unknown;
  providerBinding: unknown;
}) {
  const { source, command } = input,
    proof = command.organization_schedule_configuration_evidence;
  if (!proof || !command.organization_schedule_configuration_snapshot)
    reject("original_snapshot_missing");
  if (
    source.billing_scope_id !== null ||
    source.merchant_key !== "platform" ||
    source.provider !== "stripe" ||
    command.billing_scope_id !== null ||
    command.app_id !== null ||
    command.merchant_key !== "platform" ||
    command.organization_id !== source.organization_id ||
    command.subscription_id !== source.id ||
    command.result_subscription_id !== source.id ||
    command.kind !== "downgrade" ||
    command.status !== "APPLIED" ||
    command.expected_subscription_revision === null ||
    command.result_subscription_revision !== command.expected_subscription_revision + 1 ||
    command.result_subscription_revision !== source.lifecycle_revision ||
    command.target_plan_key !== source.pending_plan_key ||
    proof.targetPlanKey !== source.pending_plan_key ||
    proof.quoteId !== input.quoteId ||
    source.provider_object_digest !== command.provider_response_digest ||
    settlementDigest(proof) !== command.provider_response_digest
  )
    reject("original_command_source_changed");
  const review = organizationDowngradeReviewSchema.parse(input.review),
    binding = organizationPlanChangeProviderBindingSchema.parse(input.providerBinding);
  assertOrganizationSubscription(source);
  const originalPlan = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version),
    target = resolveSubscriptionPlanDefinition(proof.targetPlanKey, source.catalog_version);
  if (
    settlementDigest(review) !== proof.reviewDigest ||
    settlementDigest(binding) !== proof.providerBindingDigest ||
    review.subscriptionId !== source.id ||
    review.expectedSubscriptionRevision !== String(command.expected_subscription_revision) ||
    review.sourcePlanKey !== source.plan_key ||
    review.targetPlanKey !== proof.targetPlanKey ||
    review.catalogVersion !== source.catalog_version ||
    !source.current_period_start ||
    !source.current_period_end ||
    Date.parse(review.currentPeriodStart) !== source.current_period_start.getTime() ||
    Date.parse(review.currentPeriodEnd) !== source.current_period_end.getTime() ||
    Date.parse(review.effectiveAt) !== proof.effectiveAt * 1000 ||
    proof.effectiveAt * 1000 !== source.current_period_end.getTime() ||
    binding.livemode !== (source.provider_environment === "live") ||
    target.amountCents >= originalPlan.amountCents ||
    review.targetBaseAmountCents !== target.amountCents ||
    review.targetAllowanceUsd !== target.allowance.amountUsd
  )
    reject("original_review_binding_changed");
  const phase = readRetainedScheduleTarget({
    originalSnapshot: command.organization_schedule_configuration_snapshot,
    originalSnapshotDigest: proof.snapshotDigest,
    scheduleId: proof.scheduleId,
    customerId: source.stripe_customer_id,
    subscriptionId: source.stripe_subscription_id,
    livemode: binding.livemode,
    targetPriceId: binding.targetPriceId,
    effectiveAt: proof.effectiveAt,
  });
  return {
    commandId: command.id,
    originalSubscriptionRevision: source.lifecycle_revision,
    currentSubscriptionRevision: source.lifecycle_revision,
    targetPlanKey: target.key,
    targetAmountCents: target.amountCents,
    targetAllowanceUsd: target.allowance.amountUsd,
    binding,
    phase,
  };
}

export function proveOriginalConfiguredTarget(
  input: Parameters<typeof proveOriginalConfiguredAuthority>[0] & {
    rawCurrentSchedule: unknown;
    observedAt: Date;
  },
) {
  const authority = proveOriginalConfiguredAuthority(input);
  const proof = input.command.organization_schedule_configuration_evidence!;
  const phase = proveRetainedScheduleTargetLifecycle({
    originalSnapshot: input.command.organization_schedule_configuration_snapshot,
    originalSnapshotDigest: proof.snapshotDigest,
    scheduleId: proof.scheduleId,
    customerId: input.source.stripe_customer_id,
    subscriptionId: input.source.stripe_subscription_id,
    livemode: authority.binding.livemode,
    targetPriceId: authority.binding.targetPriceId,
    effectiveAt: proof.effectiveAt,
    rawCurrentSchedule: input.rawCurrentSchedule,
    observedAt: input.observedAt,
  });
  return { ...authority, phase };
}
