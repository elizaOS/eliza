/** Opens durable subscription incidents for provider observations no lifecycle owner may publish (out-of-band plan or schedule changes, trials, pauses, refunds, disputes, rejected renewals). The incident is the operator signal; it never changes entitlement. */
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { subscriptionBillingOperationsRepository as operations } from "../../db/repositories/subscription-billing-operations";
import { billingSubscriptions } from "../../db/schemas/billing-subscriptions";
import type {
  BillingSubscriptionIncidentKind,
  BillingSubscriptionIncidentSeverity,
} from "../../db/schemas/subscription-billing-operations";
import { logger } from "../utils/logger";

export interface SubscriptionIncidentSource {
  organizationId: string;
  subscriptionId: string;
}

/**
 * One open incident per subscription, reason and observation kind; repeat
 * deliveries increment its occurrence count. Context is deterministic so
 * replays compare equal; event identity goes to the structured log.
 */
export async function openSubscriptionIncident(input: {
  source: SubscriptionIncidentSource;
  kind: BillingSubscriptionIncidentKind;
  severity: BillingSubscriptionIncidentSeverity;
  reason: string;
  observedBy: string;
  eventId?: string | null;
}): Promise<void> {
  const fingerprint = createHash("sha256")
    .update(
      `subscription-incident:${input.reason}:${input.observedBy}:${input.source.subscriptionId}`,
    )
    .digest("hex");
  const incident = await operations.openIncident({
    organizationId: input.source.organizationId,
    subscriptionId: input.source.subscriptionId,
    commandId: null,
    eventReceiptId: null,
    kind: input.kind,
    severity: input.severity,
    fingerprint,
    context: { reason: input.reason, observedBy: input.observedBy },
    nextRetryAt: null,
    now: new Date(),
  });
  logger.warn("[Subscription Incident] Provider observation requires operator review", {
    code: "subscription_incident_opened",
    reason: input.reason,
    observedBy: input.observedBy,
    eventId: input.eventId ?? null,
    organizationId: input.source.organizationId,
    subscriptionId: input.source.subscriptionId,
    incidentId: incident.value.id,
    occurrences: incident.value.occurrence_count,
  });
}

/** Resolves a platform organization subscription by provider identity; unknown subscriptions have no tenant to attach an incident to. */
export async function findPlatformSubscriptionSource(
  stripeSubscriptionId: string,
  livemode: boolean,
): Promise<SubscriptionIncidentSource | null> {
  const [source] = await dbWrite
    .select({
      organizationId: billingSubscriptions.organization_id,
      subscriptionId: billingSubscriptions.id,
    })
    .from(billingSubscriptions)
    .where(
      and(
        isNull(billingSubscriptions.billing_scope_id),
        eq(billingSubscriptions.provider, "stripe"),
        eq(billingSubscriptions.provider_environment, livemode ? "live" : "test"),
        eq(billingSubscriptions.stripe_subscription_id, stripeSubscriptionId),
      ),
    )
    .limit(1);
  return source ?? null;
}

/** Queue-side entry point: attaches the incident to the known subscription, or logs that no tenant owns it. */
export async function openSubscriptionEventIncident(input: {
  stripeSubscriptionId: string;
  livemode: boolean;
  eventId: string;
  eventType: string;
  kind: BillingSubscriptionIncidentKind;
  severity: BillingSubscriptionIncidentSeverity;
  reason: string;
}): Promise<boolean> {
  const source = await findPlatformSubscriptionSource(input.stripeSubscriptionId, input.livemode);
  if (!source) {
    logger.warn(
      "[Subscription Incident] Provider observation has no known organization subscription",
      {
        code: "subscription_incident_unknown_subscription",
        reason: input.reason,
        eventId: input.eventId,
        eventType: input.eventType,
        stripeSubscriptionId: input.stripeSubscriptionId,
      },
    );
    return false;
  }
  await openSubscriptionIncident({
    source,
    kind: input.kind,
    severity: input.severity,
    reason: input.reason,
    observedBy: input.eventType,
    eventId: input.eventId,
  });
  return true;
}
