/** Structural target observation only. Requires separately verified original command and payment authority. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { proveOriginalConfiguredTarget } from "./organization-schedule-target-authority";
import { settlementDigest } from "./settlement-digest";
import { organizationSubscriptionObservationSchema } from "./stripe-organization-subscription-observation";

function reject(reason: string): never {
  throw new ElizaError("Scheduled target subscription is not current original authority", {
    code: "SUBSCRIPTION_SCHEDULE_TARGET_UNVERIFIED",
    context: { reason },
  });
}
export function observeScheduledTargetLiveSubscription(
  input: {
    source: Parameters<typeof proveOriginalConfiguredTarget>[0]["source"];
    authority: ReturnType<typeof proveOriginalConfiguredTarget>;
    organizationCustomerId: string | null;
    rawSubscription: unknown;
    rawCustomer: unknown;
    observedAt: Date;
    retainedCanceledAt: Date | null;
  },
  expectedStatus: "active" | "past_due" | "unpaid" = "active",
) {
  const { source, authority } = input,
    { binding, phase } = authority;
  const sub = organizationSubscriptionObservationSchema
    .extend({
      status: z.literal(expectedStatus),
      schedule: phase.state === "active" ? z.literal(phase.scheduleId) : z.null(),
      latest_invoice: z.string().regex(/^in_[A-Za-z0-9]+$/),
      trial_start: z.null(),
      trial_end: z.null(),
      cancel_at_period_end: z.literal(false),
      cancel_at: z.null(),
      collection_method: z.literal("charge_automatically"),
    })
    .safeParse(input.rawSubscription);
  const customer = z
    .object({
      id: z.string(),
      object: z.literal("customer"),
      livemode: z.boolean(),
      deleted: z.literal(false).optional(),
    })
    .safeParse(input.rawCustomer);
  if (!sub.success || !customer.success) reject("unsupported_target_observation");
  const observed = sub.data,
    item = observed.items.data[0]!;
  const now = input.observedAt.getTime();
  if (
    !Number.isFinite(now) ||
    phase.start.getTime() > now ||
    authority.currentSubscriptionRevision !== source.lifecycle_revision ||
    authority.targetPlanKey !== source.pending_plan_key ||
    observed.id !== source.stripe_subscription_id ||
    observed.customer !== source.stripe_customer_id ||
    input.organizationCustomerId !== source.stripe_customer_id ||
    customer.data.id !== source.stripe_customer_id ||
    observed.livemode !== binding.livemode ||
    customer.data.livemode !== binding.livemode ||
    (source.provider_environment === "live") !== binding.livemode ||
    observed.current_period_start * 1000 > now ||
    observed.current_period_end * 1000 <= now ||
    observed.current_period_start >= observed.current_period_end ||
    (phase.end.getTime() > now
      ? observed.current_period_start * 1000 !== phase.start.getTime() ||
        observed.current_period_end * 1000 !== phase.end.getTime()
      : phase.state === "active" || observed.current_period_start * 1000 < phase.end.getTime()) ||
    observed.canceled_at !==
      (input.retainedCanceledAt === null ? null : input.retainedCanceledAt.getTime() / 1000) ||
    !/^si_[A-Za-z0-9]+$/.test(item.id) ||
    item.price.id !== binding.targetPriceId ||
    item.price.product !== binding.targetProductId ||
    item.price.livemode !== binding.livemode ||
    item.price.unit_amount !== authority.targetAmountCents
  )
    reject("target_identity_period_or_catalog_changed");
  // This proves live compatibility only. Neither active status nor latest_invoice
  // proves payment for this or any earlier interval. Historical invoice item identity
  // belongs to that authenticated invoice, not necessarily this live item.
  return {
    providerStatus: observed.status,
    periodStart: new Date(observed.current_period_start * 1000),
    periodEnd: new Date(observed.current_period_end * 1000),
    subscriptionItemId: item.id,
    invoiceId: observed.latest_invoice,
    providerObjectDigest: settlementDigest(input.rawSubscription),
  };
}

/** Original-period settlement requires both the original interval and its current invoice.
 * Historical payment callers must separately prove their invoice and publish in order. */
export function observeScheduledTargetSubscription(
  input: Parameters<typeof observeScheduledTargetLiveSubscription>[0] & { invoiceId: string },
  expectedStatus: "active" | "past_due" | "unpaid" = "active",
) {
  const observed = observeScheduledTargetLiveSubscription(input, expectedStatus);
  if (
    input.authority.phase.end.getTime() <= input.observedAt.getTime() ||
    observed.periodStart.getTime() !== input.authority.phase.start.getTime() ||
    observed.periodEnd.getTime() !== input.authority.phase.end.getTime() ||
    observed.invoiceId !== input.invoiceId
  )
    reject("target_identity_period_or_catalog_changed");
  return {
    subscriptionItemId: observed.subscriptionItemId,
    invoiceId: observed.invoiceId,
    providerObjectDigest: observed.providerObjectDigest,
  };
}
