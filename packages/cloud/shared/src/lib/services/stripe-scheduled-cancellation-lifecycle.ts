/** Retrieves canonical Stripe authority to reconcile a previously applied cancellation command; unrelated active lifecycle remains retryable. */

import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { z } from "zod";
import { dbWrite } from "../../db/helpers";
import { subscriptionBillingOperationsRepository as operations } from "../../db/repositories/subscription-billing-operations";
import { SCHEDULED_CANCELLATION_DISPOSITION } from "../../db/repositories/subscription-cancellation-event-finalization";
import { subscriptionEntitlementsRepository } from "../../db/repositories/subscription-entitlements";
import { TERMINAL_LIFECYCLE_DISPOSITION } from "../../db/repositories/subscription-lifecycle-finalization";
import { billingSubscriptions } from "../../db/schemas/billing-subscriptions";
import { organizations } from "../../db/schemas/organizations";
import { billingSubscriptionCommands } from "../../db/schemas/subscription-billing-operations";
import type { StripeEventMessage } from "../../types/stripe-queue-message";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import {
  validateCancellationCustomer,
  validatePeriodEndCancellationObservation,
} from "./stripe-period-end-cancellation";
import { reconcileStripeTerminalLifecycle } from "./stripe-terminal-lifecycle";

const seconds = z.number().int().nonnegative().safe();
const eventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
  type: z.literal("customer.subscription.updated"),
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
function reject(reason: string): never {
  throw new ElizaError("Stripe lifecycle requires reconciliation before publication", {
    code: "SUBSCRIPTION_LIFECYCLE_REOBSERVE",
    context: { reason },
  });
}
function digest(value: Stripe.Event | Stripe.Subscription): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function reconcileStripeScheduledCancellationLifecycle(
  message: StripeEventMessage,
): Promise<void> {
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
    [SCHEDULED_CANCELLATION_DISPOSITION, TERMINAL_LIFECYCLE_DISPOSITION].includes(
      recorded.value.disposition ?? "",
    )
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
    const stripe = requireStripe();
    const raw = await stripe.subscriptions.retrieve(source.stripe_subscription_id);
    if (raw.status === "canceled" || raw.status === "incomplete_expired") {
      await operations.releaseEventForRetry(lease);
      return await reconcileStripeTerminalLifecycle(message);
    }
    const commands = await dbWrite
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, source.organization_id),
          eq(billingSubscriptionCommands.subscription_id, source.id),
          eq(billingSubscriptionCommands.kind, "cancel"),
          eq(billingSubscriptionCommands.status, "APPLIED"),
        ),
      )
      .limit(2);
    if (commands.length !== 1) reject("ambiguous_applied_command");
    const command = commands[0]!;
    if (
      !command ||
      command.result_subscription_id !== source.id ||
      command.result_subscription_revision === null
    )
      reject("applied_command_required");
    const [organization] = await dbWrite
      .select({ customer: organizations.stripe_customer_id })
      .from(organizations)
      .where(eq(organizations.id, source.organization_id));
    if (!organization) reject("organization_unavailable");
    const environment = getCloudAwareEnv();
    const customer = await stripe.customers.retrieve(source.stripe_customer_id);
    validateCancellationCustomer({
      raw: customer,
      source,
      organizationCustomerId: organization.customer,
      environment,
    });
    validatePeriodEndCancellationObservation({
      source,
      organizationCustomerId: organization.customer,
      environment,
      raw,
      observedAt: new Date(),
      requireScheduled: true,
    });
    await operations.finalizeCancellationEvent({
      ...lease,
      commandId: command.id,
      subscriptionId: source.id,
      expectedSubscriptionRevision: source.lifecycle_revision,
      expectedProjectionRevision: projection?.projection_revision ?? null,
      providerEventId: event.id,
      eventCreatedAt: new Date(event.created * 1000),
      raw,
      customer,
    });
  } catch (error) {
    // error-policy:J2 Release only this worker's live lease, then preserve the original retryable failure.
    await operations.releaseEventForRetry(lease);
    throw error;
  }
}
