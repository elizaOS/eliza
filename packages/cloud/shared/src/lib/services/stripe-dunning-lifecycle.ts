/** Owns Stripe past_due/unpaid observations for known organization subscriptions: retrieves platform authority after capturing revisions, validates identity against the stored source, then publishes dunning with its receipt atomically. */
import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import { z } from "zod";
import { dbWrite } from "../../db/helpers";
import { subscriptionBillingOperationsRepository as operations } from "../../db/repositories/subscription-billing-operations";
import {
  DUNNING_LIFECYCLE_DISPOSITION,
  type DunningObservation,
  finalizeDunningEvent,
} from "../../db/repositories/subscription-dunning-finalization";
import { subscriptionEntitlementsRepository } from "../../db/repositories/subscription-entitlements";
import { NO_OWNED_CHANGE_DISPOSITION } from "../../db/repositories/subscription-lifecycle-finalization";
import {
  type BillingSubscription,
  billingSubscriptions,
} from "../../db/schemas/billing-subscriptions";
import type { StripeEventMessage } from "../../types/stripe-queue-message";
import { requireStripe } from "../stripe";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { retrieveStripeDunningObservation } from "./stripe-dunning-objects";
import {
  resolveSubscriptionPlanDefinition,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";

const seconds = z.number().int().nonnegative().safe();
const eventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
  type: z.enum(["invoice.payment_failed", "customer.subscription.updated"]),
  created: seconds,
  livemode: z.boolean(),
  account: z.never().optional(),
  context: z.never().optional(),
  data: z.object({
    object: z.object({
      id: z.string().regex(/^(in|sub)_[A-Za-z0-9]+$/),
      object: z.enum(["invoice", "subscription"]),
    }),
  }),
});
const subscriptionSchema = z.object({
  id: z.string(),
  object: z.literal("subscription"),
  livemode: z.boolean(),
  customer: z.string(),
  status: z.enum(["past_due", "unpaid"]),
  ended_at: z.null(),
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
          }),
        }),
      )
      .length(1),
  }),
});
function reject(reason: string): never {
  throw new ElizaError("Stripe dunning requires reconciliation before publication", {
    code: "SUBSCRIPTION_LIFECYCLE_REOBSERVE",
    context: { reason },
  });
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Shared by the webhook owner and recovery: identity and catalog must match; status is Stripe's. */
export function validateStripeDunningObservation(
  raw: unknown,
  source: BillingSubscription,
  environment: Record<string, string | undefined>,
): DunningObservation {
  assertOrganizationSubscription(source);
  const observed = subscriptionSchema.safeParse(raw);
  if (!observed.success) reject("unsupported_provider_observation");
  const subscription = observed.data;
  const item = subscription.items.data[0]!;
  const binding = resolveSubscriptionProviderBinding(
    environment,
    source.plan_key,
    source.catalog_version,
  );
  const plan = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
  if (
    subscription.id !== source.stripe_subscription_id ||
    subscription.livemode !== binding.expectedLivemode ||
    subscription.livemode !== (source.provider_environment === "live") ||
    subscription.customer !== source.stripe_customer_id ||
    item.id !== source.stripe_subscription_item_id ||
    item.price.id !== binding.priceId ||
    item.price.product !== binding.productId ||
    item.price.livemode !== binding.expectedLivemode ||
    item.price.unit_amount !== plan.amountCents
  )
    reject("provider_identity_or_catalog_mismatch");
  return { providerStatus: subscription.status, providerObjectDigest: digest(raw) };
}

/** Invoice-failure and live past_due/unpaid subscription updates. The router resolves the Stripe subscription from the fetched invoice or event object. */
export async function reconcileStripeDunningLifecycle(
  message: StripeEventMessage,
  stripeSubscriptionId: string,
): Promise<void> {
  const parsed = eventSchema.safeParse(message.event);
  if (!parsed.success) reject("unsupported_event_authority");
  const event = parsed.data;
  if (message.eventId !== event.id || message.eventType !== event.type)
    reject("queue_identity_mismatch");
  if (
    (event.type === "invoice.payment_failed" && event.data.object.object !== "invoice") ||
    (event.type === "customer.subscription.updated" && event.data.object.object !== "subscription")
  )
    reject("queue_object_type_mismatch");
  if (
    event.type === "customer.subscription.updated" &&
    event.data.object.id !== stripeSubscriptionId
  )
    reject("queue_identity_mismatch");
  const [source] = await dbWrite
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        isNull(billingSubscriptions.billing_scope_id),
        eq(billingSubscriptions.provider, "stripe"),
        eq(billingSubscriptions.provider_environment, event.livemode ? "live" : "test"),
        eq(billingSubscriptions.stripe_subscription_id, stripeSubscriptionId),
      ),
    )
    .limit(1);
  if (!source) reject("unknown_subscription");
  const recorded = await operations.recordEvent({
    organizationId: source.organization_id,
    subscriptionId: source.id,
    providerEventId: event.id,
    eventType: event.type,
    providerObjectType: event.data.object.object,
    providerObjectId: event.data.object.id,
    livemode: event.livemode,
    eventCreatedAt: new Date(event.created * 1_000),
    payloadDigest: digest(message.event),
    now: new Date(),
  });
  if (
    (recorded.value.status === "applied" &&
      recorded.value.disposition === DUNNING_LIFECYCLE_DISPOSITION) ||
    (recorded.value.status === "ignored" &&
      recorded.value.disposition === NO_OWNED_CHANGE_DISPOSITION)
  )
    return;
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
    const raw: Stripe.Subscription = await requireStripe().subscriptions.retrieve(
      source.stripe_subscription_id,
    );
    if (raw.status !== "past_due" && raw.status !== "unpaid") reject("provider_status_changed");
    const observation = await retrieveStripeDunningObservation(source, raw, requireStripe());
    await finalizeDunningEvent({
      ...lease,
      subscriptionId: source.id,
      expectedSubscriptionRevision: source.lifecycle_revision,
      expectedProjectionRevision: projection?.projection_revision ?? null,
      providerEventId: event.id,
      eventCreatedAt: new Date(event.created * 1000),
      observation,
    });
  } catch (error) {
    // error-policy:J2 Release only this worker's live lease, then preserve the original failure for the router's typed classification.
    await operations.releaseEventForRetry(lease);
    throw error;
  }
}
