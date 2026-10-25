/** Compose original configuration and independent live compatibility without payment authority. */
import { z } from "zod";
import { organizationPlanChangeProviderBindingSchema } from "./organization-plan-change-provider-binding";
import {
  proveOriginalReviewedOrganizationScheduleConfiguration,
  proveReviewedOrganizationScheduleConfiguration,
} from "./organization-schedule-reviewed-configuration";
import { proveRetainedScheduleTargetLifecycle } from "./organization-schedule-target-lifecycle";
import { observeRetainedScheduleTargetLiveSubscription } from "./organization-schedule-target-observation";
import { resolveSubscriptionPlanDefinition } from "./subscription-catalog";

/** Call with the locked original source/review and fresh authenticated provider observations.
 * This records configuration only: paid interval, plan and allowance must not advance. */
export function proveOrganizationSchedulePublication(
  input: Parameters<typeof proveReviewedOrganizationScheduleConfiguration>[0] & {
    organizationCustomerId: string | null;
  },
) {
  const original = proveOriginalReviewedOrganizationScheduleConfiguration(input);
  if (input.originalConfiguration.observedAt.getTime() < original.effectiveAt * 1000) {
    return {
      ...proveReviewedOrganizationScheduleConfiguration(input),
      configuredSnapshot: original.configuredSnapshot,
    };
  }
  const binding = organizationPlanChangeProviderBindingSchema.parse(input.providerBinding);
  const phase = proveRetainedScheduleTargetLifecycle({
    originalSnapshot: original.configuredSnapshot,
    originalSnapshotDigest: original.snapshotDigest,
    scheduleId: original.scheduleId,
    customerId: input.source.stripe_customer_id,
    subscriptionId: input.source.stripe_subscription_id,
    livemode: binding.livemode,
    targetPriceId: binding.targetPriceId,
    effectiveAt: original.effectiveAt,
    rawCurrentSchedule: input.rawCurrentSchedule,
    observedAt: input.originalConfiguration.observedAt,
  });
  const status = z
    .object({ status: z.enum(["active", "past_due", "unpaid"]) })
    .parse(input.rawSubscription).status;
  observeRetainedScheduleTargetLiveSubscription(
    {
      subscriptionId: input.source.stripe_subscription_id,
      customerId: input.source.stripe_customer_id,
      providerEnvironment: input.source.provider_environment,
      binding,
      phase,
      targetAmountCents: resolveSubscriptionPlanDefinition(
        original.targetPlanKey,
        input.source.catalog_version,
      ).amountCents,
      organizationCustomerId: input.organizationCustomerId,
      rawSubscription: input.rawSubscription,
      rawCustomer: input.rawCustomer,
      observedAt: input.originalConfiguration.observedAt,
      retainedCanceledAt: input.source.canceled_at,
    },
    status,
  );
  return original;
}
