/** Retrieves platform Stripe authority for known organization subscriptions before atomically publishing terminal lifecycle and its durable receipt. Unsupported policy and ambiguous observations remain retryable. */
import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { z } from "zod";
import { dbWrite } from "../../db/helpers";
import { subscriptionBillingOperationsRepository as operations } from "../../db/repositories/subscription-billing-operations";
import { subscriptionEntitlementsRepository } from "../../db/repositories/subscription-entitlements";
import { TERMINAL_LIFECYCLE_DISPOSITION } from "../../db/repositories/subscription-lifecycle-finalization";
import { billingSubscriptions } from "../../db/schemas/billing-subscriptions";
import type { StripeEventMessage } from "../../types/stripe-queue-message";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import {
  resolveSubscriptionPlanDefinition,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";

const seconds = z.number().int().nonnegative().safe();
const eventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
  type: z.enum(["customer.subscription.updated", "customer.subscription.deleted"]),
  created: seconds,
  livemode: z.boolean(),
  account: z.never().optional(),
  context: z.never().optional(),
  data: z.object({
    object: z.object({
      id: z.string().regex(/^sub_[A-Za-z0-9]+$/),
      object: z.literal("subscription"),
    }),
  }),
});
const subscriptionSchema = z.object({
  id: z.string(),
  object: z.literal("subscription"),
  livemode: z.boolean(),
  customer: z.string(),
  status: z.enum(["canceled", "incomplete_expired"]),
  current_period_start: seconds,
  current_period_end: seconds,
  cancel_at_period_end: z.boolean(),
  canceled_at: seconds.nullable(),
  ended_at: seconds.nullable(),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
  application_fee_percent: z.null(),
  schedule: z.null(),
  pending_update: z.null(),
  pause_collection: z.null(),
  items: z.object({
    has_more: z.literal(false),
    data: z
      .array(
        z.object({
          id: z.string(),
          object: z.literal("subscription_item"),
          quantity: z.literal(1),
          price: z.object({
            id: z.string(),
            product: z.string(),
            livemode: z.boolean(),
            currency: z.literal("usd"),
            unit_amount: z.number().int(),
            type: z.literal("recurring"),
            billing_scheme: z.literal("per_unit"),
            transform_quantity: z.null(),
            recurring: z.object({
              interval: z.literal("month"),
              interval_count: z.literal(1),
              usage_type: z.literal("licensed"),
              trial_period_days: z.null(),
            }),
          }),
        }),
      )
      .length(1),
  }),
});
function reject(reason: string): never {
  throw new ElizaError("Stripe lifecycle requires reconciliation before publication", {
    code: "SUBSCRIPTION_LIFECYCLE_REOBSERVE",
    context: { reason },
  });
}
function digest(value: Stripe.Event | Stripe.Subscription): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
const asDate = (value: number | null): Date | null =>
  value === null ? null : new Date(value * 1_000);

export async function reconcileStripeTerminalLifecycle(message: StripeEventMessage): Promise<void> {
  const parsed = eventSchema.safeParse(message.event);
  if (!parsed.success) reject("unsupported_event_authority");
  const event = parsed.data;
  if (message.eventId !== event.id || message.eventType !== event.type)
    reject("queue_identity_mismatch");
  const [source] = await dbWrite
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.provider, "stripe"),
        eq(billingSubscriptions.provider_environment, event.livemode ? "live" : "test"),
        eq(billingSubscriptions.stripe_subscription_id, event.data.object.id),
      ),
    )
    .limit(1);
  if (!source) reject("unknown_subscription");
  const recorded = await operations.recordEvent({
    organizationId: source.organization_id,
    subscriptionId: source.id,
    providerEventId: event.id,
    eventType: event.type,
    providerObjectType: "subscription",
    providerObjectId: source.stripe_subscription_id,
    livemode: event.livemode,
    eventCreatedAt: new Date(event.created * 1_000),
    payloadDigest: digest(message.event),
    now: new Date(),
  });
  if (
    recorded.value.status === "applied" &&
    recorded.value.disposition === TERMINAL_LIFECYCLE_DISPOSITION
  )
    return;
  // Historical receipt replay proves only prior application, not current source authority.
  if (
    source.last_provider_event_created_at !== null &&
    event.created * 1000 < source.last_provider_event_created_at.getTime()
  )
    reject("out_of_order_event_requires_reconciliation");
  const lease = {
    organizationId: source.organization_id,
    receiptId: recorded.value.id,
    leaseToken: randomUUID(),
  };
  if (!(await operations.claimEvent({ ...lease, leaseDurationMs: 60_000 })))
    reject("receipt_lease_unavailable");
  try {
    // Capture both revisions before any provider request. A conflict requires a new retrieval.
    const projection = await subscriptionEntitlementsRepository.find(source.organization_id);
    const binding = resolveSubscriptionProviderBinding(
      getCloudAwareEnv(),
      source.plan_key,
      source.catalog_version,
    );
    if (binding.expectedLivemode !== event.livemode) reject("deployment_environment_mismatch");
    const stripe = requireStripe();
    // No stripeAccount option: infrastructure authority belongs only to the configured platform merchant.
    const raw = await stripe.subscriptions.retrieve(source.stripe_subscription_id);
    const observed = subscriptionSchema.safeParse(raw);
    if (!observed.success) reject("unsupported_provider_observation");
    const subscription = observed.data;
    const item = subscription.items.data[0]!;
    const plan = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
    if (
      subscription.id !== source.stripe_subscription_id ||
      subscription.livemode !== event.livemode ||
      subscription.customer !== source.stripe_customer_id ||
      item.id !== source.stripe_subscription_item_id ||
      item.price.id !== binding.priceId ||
      item.price.product !== binding.productId ||
      item.price.livemode !== event.livemode ||
      item.price.unit_amount !== plan.amountCents
    )
      reject("provider_identity_or_catalog_mismatch");
    await operations.finalizeLifecycleEvent({
      ...lease,
      subscriptionId: source.id,
      expectedSubscriptionRevision: source.lifecycle_revision,
      expectedProjectionRevision: projection?.projection_revision ?? null,
      observation: {
        provider: "stripe",
        provider_environment: source.provider_environment,
        stripe_customer_id: subscription.customer,
        stripe_subscription_id: subscription.id,
        stripe_subscription_item_id: item.id,
        catalog_version: source.catalog_version,
        plan_key: source.plan_key,
        status: subscription.status,
        current_period_start: asDate(subscription.current_period_start),
        current_period_end: asDate(subscription.current_period_end),
        cancel_at_period_end: subscription.cancel_at_period_end,
        canceled_at: asDate(subscription.canceled_at),
        ended_at: asDate(subscription.ended_at),
        dunning_started_at: source.dunning_started_at,
        grace_expires_at: source.grace_expires_at,
        pending_plan_key: source.pending_plan_key,
        last_provider_event_id: event.id,
        last_provider_event_created_at: new Date(event.created * 1_000),
        provider_object_digest: digest(raw),
      },
    });
  } catch (error) {
    // error-policy:J2 Release only this worker's live lease, then preserve the original retryable failure.
    await operations.releaseEventForRetry(lease);
    throw error;
  }
}
