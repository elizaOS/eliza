/** Retrieves canonical Stripe authority to reconcile a previously applied cancellation or undo command. Active observations no local command produced (renewals, dashboard or portal edits) are acknowledged as no_owned_change, with an incident for out-of-band plan or schedule changes; an in-flight local command keeps the delivery retryable. */

import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import { z } from "zod";
import { dbWrite, writeTransaction } from "../../db/helpers";
import { readConfiguredCancellationAuthority } from "../../db/repositories/configured-schedule-cancellation-authority";
import { subscriptionBillingOperationsRepository as operations } from "../../db/repositories/subscription-billing-operations";
import { SCHEDULED_CANCELLATION_DISPOSITION } from "../../db/repositories/subscription-cancellation-event-finalization";
import { subscriptionEntitlementsRepository } from "../../db/repositories/subscription-entitlements";
import {
  NO_OWNED_CHANGE_DISPOSITION,
  TERMINAL_LIFECYCLE_DISPOSITION,
} from "../../db/repositories/subscription-lifecycle-finalization";
import {
  type BillingSubscription,
  billingSubscriptions,
} from "../../db/schemas/billing-subscriptions";
import { organizations } from "../../db/schemas/organizations";
import { billingSubscriptionCommands } from "../../db/schemas/subscription-billing-operations";
import type { StripeEventMessage } from "../../types/stripe-queue-message";
import { requireStripe } from "../stripe";
import { logger } from "../utils/logger";
import { observeConfiguredCancellation } from "./configured-schedule-cancellation";
import {
  validateCancellationCustomer,
  validatePeriodEndCancellationObservation,
} from "./stripe-period-end-cancellation";
import { reconcileStripeTerminalLifecycle } from "./stripe-terminal-lifecycle";
import { resolveSubscriptionProviderBinding } from "./subscription-catalog";
import { openSubscriptionIncident } from "./subscription-event-incidents";
import { retrieveSubscriptionLifecycleBinding } from "./subscription-lifecycle-provider-binding";

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
/** A local cancel/resume command that has not reached APPLIED still owns the provider schedule. */
export async function hasInFlightScheduleCommand(
  source: Pick<BillingSubscription, "id" | "organization_id">,
): Promise<boolean> {
  const [inFlight] = await dbWrite
    .select({ id: billingSubscriptionCommands.id })
    .from(billingSubscriptionCommands)
    .where(
      and(
        isNull(billingSubscriptionCommands.billing_scope_id),
        isNull(billingSubscriptionCommands.app_id),
        eq(billingSubscriptionCommands.organization_id, source.organization_id),
        eq(billingSubscriptionCommands.subscription_id, source.id),
        inArray(billingSubscriptionCommands.kind, ["cancel", "resume"]),
        inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN", "SUCCEEDED"]),
      ),
    )
    .limit(1);
  return inFlight !== undefined;
}
const periodSchema = z.object({ current_period_end: seconds, current_period_start: seconds });
/** Stripe advanced the period (a renewal) relative to the stored source. */
function observedPeriodChanged(raw: unknown, source: BillingSubscription): boolean {
  const period = periodSchema.safeParse(raw);
  return (
    !period.success ||
    period.data.current_period_start * 1000 !== source.current_period_start?.getTime() ||
    period.data.current_period_end * 1000 !== source.current_period_end?.getTime()
  );
}
const driftSchema = z.object({
  customer: z.union([z.string(), z.object({ id: z.string() })]),
  cancel_at_period_end: z.boolean(),
  cancel_at: seconds.nullable(),
  schedule: z.unknown(),
  pending_update: z.unknown(),
  pause_collection: z.unknown(),
  items: z.object({
    data: z.array(z.object({ id: z.string(), price: z.object({ id: z.string() }) })),
  }),
});
/** Names an out-of-band provider change that no local owner may publish; null for renewals and benign updates. */
export function unownedObservationDrift(
  raw: unknown,
  source: BillingSubscription,
  environment: Record<string, string | undefined>,
): string | null {
  const observed = driftSchema.safeParse(raw);
  if (!observed.success) return "unsupported_provider_observation";
  const subscription = observed.data;
  const item = subscription.items.data[0];
  const customer =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const binding =
    source.plan_key === "plus_monthly" || source.plan_key === "pro_monthly"
      ? resolveSubscriptionProviderBinding(environment, source.plan_key, source.catalog_version)
      : null;
  if (
    !binding ||
    subscription.items.data.length !== 1 ||
    !item ||
    item.id !== source.stripe_subscription_item_id ||
    item.price.id !== binding.priceId ||
    customer !== source.stripe_customer_id
  )
    return "plan_changed_out_of_band";
  if (
    (subscription.schedule ?? null) !== null ||
    (subscription.pending_update ?? null) !== null ||
    (subscription.pause_collection ?? null) !== null
  )
    return "provider_update_not_owned";
  if (
    subscription.cancel_at_period_end !== source.cancel_at_period_end ||
    (subscription.cancel_at !== null && !source.cancel_at_period_end)
  )
    return "cancellation_not_owned";
  return null;
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
        isNull(billingSubscriptions.billing_scope_id),
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
    (recorded.value.status === "applied" &&
      [SCHEDULED_CANCELLATION_DISPOSITION, TERMINAL_LIFECYCLE_DISPOSITION].includes(
        recorded.value.disposition ?? "",
      )) ||
    (recorded.value.status === "ignored" &&
      recorded.value.disposition === NO_OWNED_CHANGE_DISPOSITION)
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
    if (raw.status === "past_due" || raw.status === "unpaid") {
      await operations.releaseEventForRetry(lease);
      const { reconcileStripeDunningLifecycle } = await import("./stripe-dunning-lifecycle");
      return await reconcileStripeDunningLifecycle(message, source.stripe_subscription_id);
    }
    const { environment, providerAccountId } = await retrieveSubscriptionLifecycleBinding(
      source,
      stripe,
    );
    // Our own cancellation or undo that has not been applied yet finalizes
    // through its command owner first; this observation retries after it.
    if (await hasInFlightScheduleCommand(source)) reject("command_in_flight");
    const commands = await dbWrite
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.organization_id, source.organization_id),
          eq(billingSubscriptionCommands.subscription_id, source.id),
          inArray(billingSubscriptionCommands.kind, ["cancel", "resume"]),
          eq(billingSubscriptionCommands.status, "APPLIED"),
        ),
      )
      .orderBy(desc(billingSubscriptionCommands.result_subscription_revision))
      .limit(1);
    // This is only a lookup hint; the finalizer proves complete latest-command lineage under the organization lock.
    const command = commands.length === 1 ? commands[0] : undefined;
    // Renewals, dashboard/portal edits and benign updates are authentic but not
    // produced by one of our commands. They are acknowledged without publication
    // (paid renewal and recovery own the source); out-of-band plan or schedule
    // changes additionally open an incident instead of retrying into the DLQ.
    if (!command || observedPeriodChanged(raw, source)) {
      const drift = unownedObservationDrift(raw, source, environment);
      if (drift)
        await openSubscriptionIncident({
          source: { organizationId: source.organization_id, subscriptionId: source.id },
          kind: "provider_drift",
          severity: "error",
          reason: drift,
          observedBy: event.type,
          eventId: event.id,
        });
      if (!(await operations.ignoreEvent({ ...lease, disposition: NO_OWNED_CHANGE_DISPOSITION })))
        reject("receipt_lease_lost");
      logger.info("[Stripe Lifecycle] Subscription update is not owned by a local command", {
        code: NO_OWNED_CHANGE_DISPOSITION,
        eventId: event.id,
        eventType: event.type,
        organizationId: source.organization_id,
        subscriptionId: source.id,
        drift,
      });
      return;
    }
    if (
      command.result_subscription_id !== source.id ||
      command.result_subscription_revision === null
    )
      reject("applied_command_required");
    const [organization] = await dbWrite
      .select({ customer: organizations.stripe_customer_id })
      .from(organizations)
      .where(eq(organizations.id, source.organization_id));
    if (!organization) reject("organization_unavailable");
    const customer = await stripe.customers.retrieve(source.stripe_customer_id);
    validateCancellationCustomer({
      raw: customer,
      source,
      organizationCustomerId: organization.customer,
      environment,
    });
    const authority = await writeTransaction((tx) =>
      readConfiguredCancellationAuthority(tx, source),
    );
    const rawSchedule = authority
      ? await stripe.subscriptionSchedules.retrieve(authority.scheduleId)
      : undefined;
    if (authority)
      observeConfiguredCancellation({
        authority,
        source,
        rawSubscription: raw,
        rawSchedule,
        observedAt: new Date(),
      });
    else
      validatePeriodEndCancellationObservation({
        source,
        organizationCustomerId: organization.customer,
        environment,
        raw,
        observedAt: new Date(),
        requireScheduled: command.kind === "cancel",
        allowRetainedCanceledAt: source.canceled_at,
      });
    await operations.finalizeCancellationEvent({
      rawSchedule,
      providerAccountId,
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
