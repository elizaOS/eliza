/** Live compatibility for ordinary renewal; never invoice payment or source publication authority. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { settlementDigest } from "./settlement-digest";
import { organizationSubscriptionObservationSchema } from "./stripe-organization-subscription-observation";

export function observeOrdinaryRenewalLiveSubscription(input: {
  source: Pick<
    BillingSubscription,
    | "stripe_subscription_id"
    | "stripe_customer_id"
    | "stripe_subscription_item_id"
    | "provider_environment"
    | "pending_plan_key"
    | "ended_at"
    | "cancel_at_period_end"
    | "canceled_at"
  >;
  raw: unknown;
  observedAt: Date;
  paidStart: Date;
  paidEnd: Date;
  historical: boolean;
  binding: { priceId: string; productId: string; expectedLivemode: boolean };
  amountCents: number;
}) {
  const parsed = organizationSubscriptionObservationSchema
    .extend({
      status: z.enum(["active", "past_due", "unpaid"]),
      latest_invoice: z.string().regex(/^in_[A-Za-z0-9]+$/),
      trial_start: z.null(),
      trial_end: z.null(),
      cancel_at_period_end: z.literal(false),
      cancel_at: z.null(),
      collection_method: z.literal("charge_automatically"),
    })
    .safeParse(input.raw);
  const reject = (): never => {
    throw new ElizaError(
      "Renewal live subscription is not compatible with retained paid authority",
      {
        code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
        context: { reason: "live_subscription_incompatible" },
      },
    );
  };
  if (!parsed.success) reject();
  const live = parsed.data!,
    item = live.items.data[0]!,
    source = input.source,
    start = new Date(live.current_period_start * 1000),
    end = new Date(live.current_period_end * 1000),
    now = input.observedAt.getTime();
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    !Number.isFinite(input.paidStart.getTime()) ||
    !Number.isFinite(input.paidEnd.getTime()) ||
    input.paidStart >= input.paidEnd ||
    input.paidStart > input.observedAt ||
    start > input.observedAt ||
    end <= input.observedAt ||
    start >= end ||
    source.pending_plan_key !== null ||
    source.ended_at !== null ||
    source.cancel_at_period_end ||
    live.id !== source.stripe_subscription_id ||
    live.customer !== source.stripe_customer_id ||
    live.livemode !== input.binding.expectedLivemode ||
    live.livemode !== (source.provider_environment === "live") ||
    live.canceled_at !==
      (source.canceled_at === null ? null : source.canceled_at.getTime() / 1000) ||
    item.id !== source.stripe_subscription_item_id ||
    item.price.id !== input.binding.priceId ||
    item.price.product !== input.binding.productId ||
    item.price.livemode !== live.livemode ||
    item.price.unit_amount !== input.amountCents ||
    (input.historical
      ? input.paidEnd > input.observedAt || start < input.paidEnd
      : live.status !== "active" ||
        start.getTime() !== input.paidStart.getTime() ||
        end.getTime() !== input.paidEnd.getTime())
  )
    reject();
  return {
    providerStatus: live.status,
    periodStart: start,
    periodEnd: end,
    subscriptionItemId: item.id,
    invoiceId: live.latest_invoice,
    providerObjectDigest: settlementDigest(input.raw),
  };
}
