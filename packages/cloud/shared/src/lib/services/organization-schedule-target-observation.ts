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
export function observeScheduledTargetSubscription(
  input: {
    source: Parameters<typeof proveOriginalConfiguredTarget>[0]["source"];
    authority: ReturnType<typeof proveOriginalConfiguredTarget>;
    organizationCustomerId: string | null;
    rawSubscription: unknown;
    rawCustomer: unknown;
    invoiceId: string;
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
    phase.end.getTime() <= now ||
    authority.currentSubscriptionRevision !== source.lifecycle_revision ||
    authority.targetPlanKey !== source.pending_plan_key ||
    observed.id !== source.stripe_subscription_id ||
    observed.customer !== source.stripe_customer_id ||
    input.organizationCustomerId !== source.stripe_customer_id ||
    customer.data.id !== source.stripe_customer_id ||
    observed.livemode !== binding.livemode ||
    customer.data.livemode !== binding.livemode ||
    (source.provider_environment === "live") !== binding.livemode ||
    observed.latest_invoice !== input.invoiceId ||
    observed.current_period_start * 1000 !== phase.start.getTime() ||
    observed.current_period_end * 1000 !== phase.end.getTime() ||
    observed.canceled_at !==
      (input.retainedCanceledAt === null ? null : input.retainedCanceledAt.getTime() / 1000) ||
    !/^si_[A-Za-z0-9]+$/.test(item.id) ||
    item.price.id !== binding.targetPriceId ||
    item.price.product !== binding.targetProductId ||
    item.price.livemode !== binding.livemode ||
    item.price.unit_amount !== authority.targetAmountCents
  )
    reject("target_identity_period_or_catalog_changed");
  // The invoice validator must bind its recurring line to this observed unique item.
  // It need not equal the previous phase's item ID; continuity is not assumed.
  return {
    subscriptionItemId: item.id,
    invoiceId: observed.latest_invoice,
    providerObjectDigest: settlementDigest(input.rawSubscription),
  };
}
