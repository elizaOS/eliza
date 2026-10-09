/** Validates the pinned platform Stripe observation for an existing organization period-end cancellation. Provider drift remains explicit uncertainty; scheduling does not end current access. */

import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { organizationSubscriptionObservationSchema as observationSchema } from "./stripe-organization-subscription-observation";
import {
  resolveSubscriptionPlanDefinition,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";

export const SUBSCRIPTION_CANCELLATION_REOBSERVE = "SUBSCRIPTION_CANCELLATION_REOBSERVE";
export function cancellationReobserve(reason: string): never {
  throw new ElizaError("Subscription cancellation requires a fresh authoritative observation", {
    code: SUBSCRIPTION_CANCELLATION_REOBSERVE,
    context: { reason },
  });
}

/** The caller supplies the command-captured source; it must not refresh the expected period or plan after provider I/O. */
export function validatePeriodEndCancellationObservation(input: {
  source: BillingSubscription;
  organizationCustomerId: string | null;
  environment: Record<string, string | undefined>;
  raw: unknown;
  observedAt: Date;
  requireScheduled: boolean;
  allowRetainedCanceledAt?: Date | null;
}) {
  const { source } = input;
  assertOrganizationSubscription(source);
  if (
    source.status !== "active" ||
    source.provider !== "stripe" ||
    source.current_period_start === null ||
    source.current_period_end === null ||
    source.current_period_end <= input.observedAt ||
    source.current_period_start >= source.current_period_end ||
    source.ended_at !== null ||
    source.pending_plan_key !== null ||
    source.dunning_started_at !== null ||
    source.grace_expires_at !== null ||
    input.organizationCustomerId === null ||
    input.organizationCustomerId !== source.stripe_customer_id
  )
    cancellationReobserve("unsupported_current_authority");
  const parsed = observationSchema.safeParse(input.raw);
  if (!parsed.success) cancellationReobserve("unsupported_provider_observation");
  const observed = parsed.data;
  const binding = resolveSubscriptionProviderBinding(
    input.environment,
    source.plan_key,
    source.catalog_version,
  );
  const plan = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
  const item = observed.items.data[0]!;
  if (
    observed.id !== source.stripe_subscription_id ||
    observed.customer !== source.stripe_customer_id ||
    observed.livemode !== (source.provider_environment === "live") ||
    observed.livemode !== binding.expectedLivemode ||
    item.id !== source.stripe_subscription_item_id ||
    item.price.id !== binding.priceId ||
    item.price.product !== binding.productId ||
    item.price.livemode !== observed.livemode ||
    item.price.unit_amount !== plan.amountCents ||
    observed.current_period_start * 1000 !== source.current_period_start.getTime() ||
    observed.current_period_end * 1000 !== source.current_period_end.getTime()
  )
    cancellationReobserve("provider_identity_catalog_or_period_changed");
  if (
    (observed.trial_end !== null && observed.trial_end * 1000 > input.observedAt.getTime()) ||
    (observed.cancel_at !== null && observed.cancel_at !== observed.current_period_end) ||
    (observed.cancel_at_period_end &&
      (observed.canceled_at === null || observed.canceled_at > observed.current_period_end)) ||
    (!observed.cancel_at_period_end &&
      ((observed.canceled_at !== null &&
        observed.canceled_at * 1000 !== input.allowRetainedCanceledAt?.getTime()) ||
        observed.cancel_at !== null)) ||
    (input.requireScheduled && !observed.cancel_at_period_end)
  )
    cancellationReobserve("cancellation_schedule_not_confirmed");
  return {
    scheduled: observed.cancel_at_period_end,
    canceledAt: observed.canceled_at === null ? null : new Date(observed.canceled_at * 1000),
    providerObjectDigest: createHash("sha256").update(JSON.stringify(input.raw)).digest("hex"),
  };
}

/** Requires the canonical platform Customer to exist in the same environment; no metadata ownership is inferred. */
export function validateCancellationCustomer(input: {
  raw: unknown;
  source: BillingSubscription;
  organizationCustomerId: string | null;
  environment: Record<string, string | undefined>;
}) {
  assertOrganizationSubscription(input.source);
  const parsed = z
    .object({
      id: z.string(),
      object: z.literal("customer"),
      livemode: z.boolean(),
      deleted: z.literal(false).optional(),
    })
    .safeParse(input.raw);
  if (
    !parsed.success ||
    input.organizationCustomerId === null ||
    input.organizationCustomerId !== input.source.stripe_customer_id ||
    parsed.data.id !== input.source.stripe_customer_id ||
    parsed.data.livemode !== (input.source.provider_environment === "live") ||
    parsed.data.livemode !==
      resolveSubscriptionProviderBinding(
        input.environment,
        input.source.plan_key,
        input.source.catalog_version,
      ).expectedLivemode
  )
    cancellationReobserve("customer_authority_unavailable");
  return parsed.data;
}
