/** Reconciles signed invoice-paid deliveries through current platform provider objects and a single paid-renewal transaction; it never initiates a payment. */
import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { dbWrite } from "../../db/helpers";
import { subscriptionBillingOperationsRepository as operations } from "../../db/repositories/subscription-billing-operations";
import { subscriptionEntitlementsRepository } from "../../db/repositories/subscription-entitlements";
import {
  finalizePaidRenewal,
  PAID_RENEWAL_DISPOSITION,
} from "../../db/repositories/subscription-renewal-finalization";
import { billingSubscriptions } from "../../db/schemas/billing-subscriptions";
import type { StripeEventMessage } from "../../types/stripe-queue-message";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import { renewalInvoiceSchema, renewalUnavailable } from "./stripe-paid-renewal-validation";
import {
  resolveSubscriptionPlanDefinition,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";

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
      subscription: z.string().regex(/^sub_[A-Za-z0-9]+$/),
    }),
  }),
});
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
  const [source] = await dbWrite
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.provider, "stripe"),
        eq(billingSubscriptions.provider_environment, event.livemode ? "live" : "test"),
        eq(billingSubscriptions.stripe_subscription_id, event.data.object.subscription),
      ),
    );
  if (!source) renewalUnavailable("unknown_subscription");
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
  const lease = {
    organizationId: source.organization_id,
    receiptId: recorded.value.id,
    leaseToken: randomUUID(),
  };
  if (!(await operations.claimEvent({ ...lease, leaseDurationMs: 60_000 })))
    renewalUnavailable("receipt_lease_unavailable");
  try {
    const projection = await subscriptionEntitlementsRepository.find(source.organization_id);
    const stripe = requireStripe();
    const invoice = await stripe.invoices.retrieve(event.data.object.id);
    const invoiceParsed = renewalInvoiceSchema.safeParse(invoice);
    if (!invoiceParsed.success) renewalUnavailable("unsupported_canonical_invoice");
    const binding = resolveSubscriptionProviderBinding(
      getCloudAwareEnv(),
      source.plan_key,
      source.catalog_version,
    );
    const plan = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
    const [subscription, customer, paymentIntent, charge, price, product] = await Promise.all([
      stripe.subscriptions.retrieve(source.stripe_subscription_id),
      stripe.customers.retrieve(source.stripe_customer_id),
      stripe.paymentIntents.retrieve(invoiceParsed.data.payment_intent),
      stripe.charges.retrieve(invoiceParsed.data.charge),
      stripe.prices.retrieve(binding.priceId),
      stripe.products.retrieve(binding.productId),
    ]);
    // Archiving a historical price prevents new purchases, not renewal of existing subscriptions.
    if (
      price.id !== binding.priceId ||
      price.product !== binding.productId ||
      price.livemode !== binding.expectedLivemode ||
      price.currency !== "usd" ||
      price.unit_amount !== plan.amountCents ||
      price.type !== "recurring" ||
      price.billing_scheme !== "per_unit" ||
      price.transform_quantity !== null ||
      !price.recurring ||
      price.recurring.interval !== "month" ||
      price.recurring.interval_count !== 1 ||
      price.recurring.usage_type !== "licensed" ||
      price.recurring.trial_period_days !== null ||
      product.id !== binding.productId ||
      ("deleted" in product && product.deleted) ||
      !("livemode" in product) ||
      product.livemode !== binding.expectedLivemode
    )
      renewalUnavailable("historical_catalog_binding_mismatch");
    await finalizePaidRenewal({
      ...lease,
      subscriptionId: source.id,
      invoiceId: event.data.object.id,
      expectedSubscriptionRevision: source.lifecycle_revision,
      expectedProjectionRevision: projection?.projection_revision ?? null,
      providerEventId: event.id,
      eventCreatedAt: created,
      invoice,
      subscription,
      customer,
      paymentIntent,
      charge,
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
