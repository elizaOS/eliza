/** Reconciles signed invoice-paid deliveries through current platform provider objects and a single paid-renewal transaction; it never initiates a payment. */
import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { dbWrite } from "../../db/helpers";
import { subscriptionBillingOperationsRepository as operations } from "../../db/repositories/subscription-billing-operations";
import { subscriptionEntitlementsRepository } from "../../db/repositories/subscription-entitlements";
import { recordOriginalInvoiceEvent } from "../../db/repositories/subscription-invoice-event-evidence";
import {
  finalizePaidRenewal,
  finalizeRecordedPaidRenewal,
  PAID_RENEWAL_DISPOSITION,
} from "../../db/repositories/subscription-renewal-finalization";
import { billingSubscriptions } from "../../db/schemas/billing-subscriptions";
import type { StripeEventMessage } from "../../types/stripe-queue-message";
import { requireStripe } from "../stripe";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { reconcileOrganizationUpgradesBeforeRenewal } from "./organization-upgrade-renewal-ordering";
import { retrievePaidRenewalObjects } from "./stripe-paid-renewal-objects";
import { renewalUnavailable } from "./stripe-paid-renewal-validation";
import { createSubscriptionInvoiceEventEvidence } from "./subscription-invoice-event-evidence";

const eventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
  type: z.literal("invoice.paid"),
  created: z.number().int().nonnegative().safe(),
  livemode: z.boolean(),
  account: z.never().optional(),
  context: z.never().optional(),
  data: z.object({
    object: z.object({
      id: z.string().regex(/^in_[A-Za-z0-9]+$/),
      object: z.literal("invoice"),
      billing_reason: z.string().optional(),
    }),
  }),
});
const subscriptionId = z.string().regex(/^sub_[A-Za-z0-9]+$/);
/**
 * Basil and later signed payloads omit `invoice.subscription`; the client is
 * pinned to Acacia, so the retrieved invoice always carries it (string or
 * expanded object). The payload only supplies the invoice identity.
 */
function invoiceSubscriptionId(invoice: object): string {
  const value = "subscription" in invoice ? invoice.subscription : undefined;
  const id =
    typeof value === "object" && value !== null && "id" in value ? value.id : (value ?? null);
  const parsed = subscriptionId.safeParse(id);
  if (!parsed.success) renewalUnavailable("invoice_subscription_unavailable");
  return parsed.data;
}
export async function reconcileStripePaidRenewal(message: StripeEventMessage): Promise<void> {
  const parsed = eventSchema.safeParse(message.event);
  if (!parsed.success) renewalUnavailable("unsupported_event_shape");
  const event = parsed.data;
  const created = new Date(event.created * 1000);
  if (
    !Number.isFinite(created.getTime()) ||
    message.eventId !== event.id ||
    message.eventType !== event.type
  )
    renewalUnavailable("event_identity_mismatch");
  const fetchedInvoice = await requireStripe().invoices.retrieve(event.data.object.id);
  const stripeSubscriptionId = invoiceSubscriptionId(fetchedInvoice);
  let [source] = await dbWrite
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        isNull(billingSubscriptions.billing_scope_id),
        eq(billingSubscriptions.provider, "stripe"),
        eq(billingSubscriptions.provider_environment, event.livemode ? "live" : "test"),
        eq(billingSubscriptions.stripe_subscription_id, stripeSubscriptionId),
      ),
    );
  if (!source) {
    const stripe = requireStripe();
    const invoice = fetchedInvoice;
    if (invoice.billing_reason !== "subscription_create")
      renewalUnavailable("unknown_subscription");
    const sessions = await stripe.checkout.sessions.list({
      subscription: stripeSubscriptionId,
      limit: 2,
    });
    if (sessions.has_more || sessions.data.length !== 1)
      renewalUnavailable("initial_checkout_ambiguous");
    const session = sessions.data[0];
    if (!session || session.invoice !== invoice.id)
      renewalUnavailable("initial_checkout_invoice_mismatch");
    const { reconcileSubscriptionCheckout } = await import("./subscription-checkout");
    await reconcileSubscriptionCheckout(session.id);
    return;
  }
  assertOrganizationSubscription(source);
  // The first invoice can arrive after Checkout already published its allowance.
  if (
    event.data.object.billing_reason === "subscription_create" ||
    fetchedInvoice.billing_reason === "subscription_create"
  ) {
    const canonicalInvoice = fetchedInvoice;
    if (canonicalInvoice.billing_reason !== "subscription_create")
      renewalUnavailable("initial_invoice_reason_mismatch");
    const sessions = await requireStripe().checkout.sessions.list({
      subscription: source.stripe_subscription_id,
      limit: 2,
    });
    const session = sessions.data[0];
    if (
      sessions.has_more ||
      sessions.data.length !== 1 ||
      !session ||
      session.invoice !== canonicalInvoice.id
    )
      renewalUnavailable("initial_checkout_ambiguous");
    const { reconcileSubscriptionCheckout } = await import("./subscription-checkout");
    await reconcileSubscriptionCheckout(session.id, source.organization_id);
    return;
  }
  // Preserve authenticated original debit observations before any grant or plan recovery.
  // Current provider state locates the owner; it must never replace the signed invoice body.
  const originalBalances = z
    .object({
      data: z.object({
        object: z.object({
          starting_balance: z.number().optional(),
          ending_balance: z.number().optional(),
        }),
      }),
    })
    .safeParse(message.event);
  const hasDebit = (value: { starting_balance?: number | null; ending_balance?: number | null }) =>
    (value.starting_balance ?? 0) > 0 || (value.ending_balance ?? 0) > 0;
  if (
    hasDebit(fetchedInvoice) ||
    (originalBalances.success && hasDebit(originalBalances.data.data.object))
  ) {
    const providerAccountId = (await requireStripe().accounts.retrieve(null)).id;
    const observation = createSubscriptionInvoiceEventEvidence(message.event, {
      organizationId: source.organization_id,
      subscriptionId: source.id,
      providerAccountId,
      customerId: source.stripe_customer_id,
      providerSubscriptionId: source.stripe_subscription_id,
      invoiceId: event.data.object.id,
      providerEventId: event.id,
      livemode: event.livemode,
    });
    await recordOriginalInvoiceEvent(
      {
        organizationId: source.organization_id,
        subscriptionId: source.id,
        providerEventId: event.id,
        eventType: event.type,
        providerObjectType: "invoice",
        providerObjectId: event.data.object.id,
        livemode: event.livemode,
        eventCreatedAt: created,
        payloadDigest: createHash("sha256").update(JSON.stringify(message.event)).digest("hex"),
        now: new Date(),
      },
      observation,
    );
    renewalUnavailable("deferred_invoice_observation_retained");
  }
  const recorded = await operations.recordEvent({
    organizationId: source.organization_id,
    subscriptionId: source.id,
    providerEventId: event.id,
    eventType: event.type,
    providerObjectType: "invoice",
    providerObjectId: event.data.object.id,
    livemode: event.livemode,
    eventCreatedAt: created,
    payloadDigest: createHash("sha256").update(JSON.stringify(message.event)).digest("hex"),
    now: new Date(),
  });
  if (
    recorded.value.status === "applied" &&
    recorded.value.disposition === PAID_RENEWAL_DISPOSITION
  )
    return;
  await reconcileOrganizationUpgradesBeforeRenewal({
    organizationId: source.organization_id,
    subscriptionId: source.id,
  });
  // Recovery can publish the original target. Capture the renewed plan/revision only afterwards.
  const originalSourceId = source.id;
  const originalOrganizationId = source.organization_id;
  [source] = await dbWrite
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.id, originalSourceId),
        eq(billingSubscriptions.organization_id, originalOrganizationId),
        isNull(billingSubscriptions.billing_scope_id),
      ),
    );
  if (!source) renewalUnavailable("source_unavailable_after_upgrade_recovery");
  assertOrganizationSubscription(source);
  const lease = {
    organizationId: source.organization_id,
    receiptId: recorded.value.id,
    leaseToken: randomUUID(),
  };
  if (!(await operations.claimEvent({ ...lease, leaseDurationMs: 60_000 })))
    renewalUnavailable("receipt_lease_unavailable");
  try {
    const projection = await subscriptionEntitlementsRepository.find(source.organization_id);
    // A distinct delivery of an already-funded invoice needs no current price, schedule or payment reads.
    // The transaction validates the original invoice, paid revision, grant and this delivery's live lease.
    if (
      await finalizeRecordedPaidRenewal({
        ...lease,
        subscriptionId: source.id,
        invoiceId: event.data.object.id,
        invoice: fetchedInvoice,
        expectedSubscriptionRevision: source.lifecycle_revision,
        expectedProjectionRevision: projection?.projection_revision ?? null,
        providerEventId: event.id,
        eventCreatedAt: created,
      })
    )
      return;
    const objects = await retrievePaidRenewalObjects(source, event.data.object.id, requireStripe());
    await finalizePaidRenewal({
      ...lease,
      subscriptionId: source.id,
      invoiceId: event.data.object.id,
      expectedSubscriptionRevision: source.lifecycle_revision,
      expectedProjectionRevision: projection?.projection_revision ?? null,
      providerEventId: event.id,
      eventCreatedAt: created,
      ...objects,
    });
  } catch (error) {
    // error-policy:J2 Release only this delivery's lease and preserve its retryable failure.
    try {
      await operations.releaseEventForRetry(lease);
      await operations.openIncident({
        organizationId: source.organization_id,
        subscriptionId: source.id,
        commandId: null,
        eventReceiptId: recorded.value.id,
        kind: "event_processing",
        severity: "error",
        fingerprint: createHash("sha256").update(`renewal:${event.id}`).digest("hex"),
        context: {
          code:
            error instanceof ElizaError ? error.code : "SUBSCRIPTION_RENEWAL_DEPENDENCY_FAILURE",
        },
        nextRetryAt: null,
        now: new Date(),
      });
    } catch (recordingError) {
      // error-policy:J2 Keep the provider/publication failure when durable retry bookkeeping also fails.
      throw new ElizaError("Renewal failed and retry bookkeeping requires recovery", {
        code: "SUBSCRIPTION_RENEWAL_RETRY_RECORDING_FAILED",
        cause: new AggregateError([error, recordingError]),
        context: { receiptId: recorded.value.id },
      });
    }
    throw error;
  }
}
