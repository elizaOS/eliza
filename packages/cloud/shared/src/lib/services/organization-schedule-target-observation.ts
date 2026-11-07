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
/** Identity/catalog/period compatibility only; callers independently prove original authority. */
export function observeRetainedScheduleTargetLiveSubscription(
  input: {
    subscriptionId: string;
    customerId: string;
    providerEnvironment: string;
    binding: ReturnType<typeof proveOriginalConfiguredTarget>["binding"];
    phase: ReturnType<typeof proveOriginalConfiguredTarget>["phase"];
    targetAmountCents: number;
    organizationCustomerId: string | null;
    rawSubscription: unknown;
    rawCustomer: unknown;
    observedAt: Date;
    retainedCanceledAt: Date | null;
  },
  expectedStatus: "active" | "past_due" | "unpaid" = "active",
) {
  const { binding, phase } = input;
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
  const periodStart = new Date(observed.current_period_start * 1000);
  const periodEnd = new Date(observed.current_period_end * 1000);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(periodStart.getTime()) ||
    !Number.isFinite(periodEnd.getTime()) ||
    phase.start.getTime() > now ||
    observed.id !== input.subscriptionId ||
    observed.customer !== input.customerId ||
    input.organizationCustomerId !== input.customerId ||
    customer.data.id !== input.customerId ||
    observed.livemode !== binding.livemode ||
    customer.data.livemode !== binding.livemode ||
    input.providerEnvironment !== (binding.livemode ? "live" : "test") ||
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
    item.price.unit_amount !== input.targetAmountCents
  )
    reject("target_identity_period_or_catalog_changed");
  // This proves live compatibility only. Neither active status nor latest_invoice
  // proves payment for this or any earlier interval. Historical invoice item identity
  // belongs to that authenticated invoice, not necessarily this live item.
  return {
    providerStatus: observed.status,
    periodStart,
    periodEnd,
    subscriptionItemId: item.id,
    invoiceId: observed.latest_invoice,
    providerObjectDigest: settlementDigest(input.rawSubscription),
  };
}

/** Published pending targets additionally require their current source revision and plan. */
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
  const { source, authority } = input;
  if (
    authority.currentSubscriptionRevision !== source.lifecycle_revision ||
    authority.targetPlanKey !== source.pending_plan_key
  )
    reject("target_identity_period_or_catalog_changed");
  return observeRetainedScheduleTargetLiveSubscription(
    {
      ...input,
      subscriptionId: source.stripe_subscription_id,
      customerId: source.stripe_customer_id,
      providerEnvironment: source.provider_environment,
      binding: authority.binding,
      phase: authority.phase,
      targetAmountCents: authority.targetAmountCents,
    },
    expectedStatus,
  );
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
