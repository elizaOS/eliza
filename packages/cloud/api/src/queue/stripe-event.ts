import {
  projectLegacyStripeCheckoutReceipt,
  projectStripeCheckoutReceipt,
} from "@elizaos/cloud-shared/lib/services/stripe-checkout-receipt";
/**
 * Redis queue consumer for Stripe events.
 *
 * Runs the heavy fan-out that used to live inline in /api/stripe/webhook
 * before the queue refactor — org credits, revenue splits,
 * redeemable earnings, cache invalidation, Discord notifications, and
 * invoice rows. The webhook route now just verifies the signature,
 * dedupes by event ID via webhook_events, enqueues, and returns 200.
 *
 * Idempotency strategy:
 *   - The webhook route uses webhook_events.tryCreate(event.id) so
 *     Stripe's at-least-once retries are caught BEFORE this consumer
 *     ever runs.
 *   - For queue retries (transient downstream failures, e.g. DB blip),
 *     this consumer additionally re-checks each downstream write:
 *       * creditsService.getTransactionByStripePaymentIntent
 *       * redeemableEarningsService.addEarnings({ dedupeBySourceId: true })
 *       * invoicesService.getByStripeInvoiceId
 *   - These guards make a queue retry safe to apply even if a previous
 *     attempt got partway through.
 *
 * Organization subscription deliveries route on the live Stripe status to
 * their owners (checkout, terminal, dunning, scheduled cancellation, paid
 * renewal). Recurring event types without an owner are acknowledged with
 * `unhandled_subscription_event`, opening an incident where operator policy
 * may be needed (trials, pauses, pending updates, refunds, disputes).
 *
 * Failure handling:
 *   - Permanent failures (bad metadata, missing required fields) ack the
 *     message — there is no recovery path and we do not want them eating
 *     retry budget.
 *   - Subscription failures branch on the typed error code and reason:
 *     unknown or out-of-order subscriptions, unsupported event shapes and
 *     parse failures ack (subscription recovery reconciles the source);
 *     unsupported provider policy acks with an incident; everything else
 *     retries.
 *   - Transient failures (DB error, downstream timeout, etc.) return
 *     `retry` with backoff across cron ticks. After the retry budget is
 *     exhausted, the Redis queue helper promotes the message to
 *     stripe-events:dlq and the cron releases its webhook_events dedupe
 *     marker so a Stripe resend can re-enter.
 */

import { createHmac } from "node:crypto";
import {
  CONTAINER_BACKED_TARGET_REJECTION_REASON,
  provisioningJobService,
} from "@elizaos/cloud-shared/agents";
import { dbRead } from "@elizaos/cloud-shared/db/helpers";
import { organizationsRepository } from "@elizaos/cloud-shared/db/repositories/organizations";
import { usersRepository } from "@elizaos/cloud-shared/db/repositories/users";
import { agentSandboxes } from "@elizaos/cloud-shared/db/schemas/agent-sandboxes";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { DrainResult } from "@elizaos/cloud-shared/lib/redis-queue";
import { safeFetch } from "@elizaos/cloud-shared/lib/security/safe-fetch";
import { autoTopUpService } from "@elizaos/cloud-shared/lib/services/auto-top-up";
import { autoTopUpChargeBreakdownFromMetadata } from "@elizaos/cloud-shared/lib/services/auto-top-up-charge-breakdown";
import { creditsService } from "@elizaos/cloud-shared/lib/services/credits";
import { discordService } from "@elizaos/cloud-shared/lib/services/discord";
import { invoicesService } from "@elizaos/cloud-shared/lib/services/invoices";
import { invalidateOrgTierCache } from "@elizaos/cloud-shared/lib/services/org-rate-limits";
import { JOB_TYPES } from "@elizaos/cloud-shared/lib/services/provisioning-job-types";
import { redeemableEarningsService } from "@elizaos/cloud-shared/lib/services/redeemable-earnings";
import { referralsService } from "@elizaos/cloud-shared/lib/services/referrals";
import { stripeCheckoutOrdersService } from "@elizaos/cloud-shared/lib/services/stripe-checkout-orders";
import { reconcileStripeScheduledCancellationLifecycle } from "@elizaos/cloud-shared/lib/services/stripe-scheduled-cancellation-lifecycle";
import { reconcileStripeTerminalLifecycle } from "@elizaos/cloud-shared/lib/services/stripe-terminal-lifecycle";
import {
  subscriptionPolicyFailureReason,
  typedFailure,
} from "@elizaos/cloud-shared/lib/services/subscription-lifecycle-failures";
import { requireStripe } from "@elizaos/cloud-shared/lib/stripe";
import { STRIPE_API_VERSION } from "@elizaos/cloud-shared/lib/stripe-api-version";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { StripeEventMessage } from "@elizaos/cloud-shared/types/stripe-queue-message";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { ZodError } from "zod";

const MAX_CREDITS = 10000;

interface StripeEventDelivery {
  body: StripeEventMessage;
  attempts: number;
}

/** Type guard: detect an expanded Stripe.Invoice on a PaymentIntent.invoice field. */
export function isInvoiceExpanded(invoice: unknown): invoice is Stripe.Invoice {
  return typeof invoice === "object" && invoice !== null && "id" in invoice;
}

/** Hard cap on the credit amount we accept from Stripe metadata, in USD. */
export const STRIPE_MAX_CREDITS = MAX_CREDITS;

/**
 * Parse a metadata "credits" string into a USD-rounded number.
 * Returns null when the input is not a finite positive number within bounds.
 */
export function parseAndValidateCredits(creditsStr: string): number | null {
  const credits = Number.parseFloat(creditsStr);
  if (!Number.isFinite(credits) || credits <= 0 || credits > MAX_CREDITS) {
    return null;
  }
  return Math.round(credits * 100) / 100;
}

function parseCreditMicros(value: string | number): bigint | null {
  const normalized =
    typeof value === "number" && Number.isFinite(value)
      ? value.toFixed(6)
      : String(value);
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(normalized);
  if (!match?.[2]) return null;
  const micros =
    BigInt(match[2]) * 1_000_000n + BigInt((match[3] ?? "").padEnd(6, "0"));
  return match[1] === "-" ? -micros : micros;
}

function formatCreditMicros(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0");
  return `${value < 0n ? "-" : ""}${whole}.${fraction}`;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

/**
 * Recurring objects cannot enter purchased-credit fulfillment. The Acacia
 * webhook shape links invoices directly; newer signed webhook versions use
 * parent.subscription_details. Metadata never establishes this distinction.
 * `ambiguous` means the linkage cannot be established (Basil payment and
 * charge objects omit `invoice`) and the delivery stays retryable.
 */
type SubscriptionLinkage =
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "recurring"; stripeSubscriptionId: string | null };

async function classifySubscriptionLinkage(
  event: Stripe.Event,
): Promise<SubscriptionLinkage> {
  const object = event.data.object;
  if (event.type.startsWith("customer.subscription.")) {
    return {
      kind: "recurring",
      stripeSubscriptionId: "id" in object ? String(object.id) : null,
    };
  }
  if (event.type.startsWith("checkout.session.")) {
    if (!("mode" in object) || object.mode !== "subscription")
      return { kind: "none" };
    return {
      kind: "recurring",
      stripeSubscriptionId:
        "subscription" in object ? referenceId(object.subscription) : null,
    };
  }
  if (event.type.startsWith("charge.dispute.")) {
    const dispute = event.data.object as Stripe.Dispute;
    const charge =
      typeof dispute.charge === "string"
        ? await requireStripe().charges.retrieve(dispute.charge)
        : dispute.charge;
    return linkedInvoiceLinkage(charge);
  }
  if (
    event.type.startsWith("payment_intent.") ||
    event.type === "charge.refunded"
  ) {
    return linkedInvoiceLinkage(object);
  }
  if (event.type.startsWith("invoice.") && isRecurringInvoice(object))
    return {
      kind: "recurring",
      stripeSubscriptionId: invoiceSubscriptionId(object),
    };
  return { kind: "none" };
}

function referenceId(value: unknown): string | null {
  if (typeof value === "string") return value;
  return typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string"
    ? value.id
    : null;
}

/** Acacia `invoice.subscription` (string or expanded) or Basil `parent.subscription_details.subscription`. */
function invoiceSubscriptionId(object: object): string | null {
  if ("subscription" in object) {
    const id = referenceId(object.subscription);
    if (id) return id;
  }
  if (
    "parent" in object &&
    typeof object.parent === "object" &&
    object.parent !== null &&
    "subscription_details" in object.parent &&
    typeof object.parent.subscription_details === "object" &&
    object.parent.subscription_details !== null &&
    "subscription" in object.parent.subscription_details
  )
    return referenceId(object.parent.subscription_details.subscription);
  return null;
}

function isRecurringInvoice(object: object): boolean {
  if (
    "subscription" in object &&
    object.subscription !== null &&
    object.subscription !== undefined
  ) {
    return true;
  }
  if (
    "parent" in object &&
    typeof object.parent === "object" &&
    object.parent !== null &&
    "type" in object.parent &&
    object.parent.type === "subscription_details"
  ) {
    return true;
  }
  return (
    "billing_reason" in object &&
    typeof object.billing_reason === "string" &&
    object.billing_reason.startsWith("subscription")
  );
}

/** Retrieve invoice authority before allowing a linked payment into legacy fulfillment. */
async function linkedInvoiceLinkage(
  object: object,
): Promise<SubscriptionLinkage> {
  // Basil removed invoice from PaymentIntent and Charge. Absence is ambiguous,
  // not proof of a one-time purchase; retain it until versioned reconciliation
  // can establish the provider linkage. Acacia explicitly uses null for none.
  if (!("invoice" in object) || object.invoice === undefined)
    return { kind: "ambiguous" };
  if (object.invoice === null) return { kind: "none" };
  const id = referenceId(object.invoice);
  // An invalid reference cannot establish one-time payment authority.
  if (!id) return { kind: "ambiguous" };
  const invoice = await requireStripe().invoices.retrieve(id);
  return isRecurringInvoice(invoice)
    ? {
        kind: "recurring",
        stripeSubscriptionId: invoiceSubscriptionId(invoice),
      }
    : { kind: "none" };
}

/**
 * Recurring event types without a lifecycle owner. They are acknowledged with
 * `unhandled_subscription_event`; those that may need operator policy open an
 * incident on the known subscription instead of retrying into the DLQ.
 */
const UNOWNED_SUBSCRIPTION_INCIDENTS: Record<
  string,
  {
    kind: "provider_drift" | "event_processing";
    severity: "warning" | "error";
    reason: string;
  }
> = {
  "invoice.created": {
    kind: "event_processing",
    severity: "warning",
    reason: "unowned_upgrade_invoice",
  },
  "invoice.paid": {
    kind: "event_processing",
    severity: "error",
    reason: "unowned_upgrade_invoice",
  },
  "customer.subscription.trial_will_end": {
    kind: "provider_drift",
    severity: "warning",
    reason: "trial_not_supported",
  },
  "customer.subscription.paused": {
    kind: "provider_drift",
    severity: "error",
    reason: "pause_not_supported",
  },
  "customer.subscription.resumed": {
    kind: "provider_drift",
    severity: "error",
    reason: "pause_not_supported",
  },
  "customer.subscription.pending_update_applied": {
    kind: "provider_drift",
    severity: "warning",
    reason: "pending_update_not_owned",
  },
  "customer.subscription.pending_update_expired": {
    kind: "provider_drift",
    severity: "warning",
    reason: "pending_update_not_owned",
  },
  "charge.refunded": {
    kind: "event_processing",
    severity: "error",
    reason: "subscription_invoice_refunded",
  },
  "charge.dispute.created": {
    kind: "event_processing",
    severity: "error",
    reason: "subscription_invoice_disputed",
  },
  "charge.dispute.funds_withdrawn": {
    kind: "event_processing",
    severity: "error",
    reason: "subscription_invoice_disputed",
  },
  "charge.dispute.funds_reinstated": {
    kind: "event_processing",
    severity: "error",
    reason: "subscription_invoice_disputed",
  },
  "charge.dispute.closed": {
    kind: "event_processing",
    severity: "error",
    reason: "subscription_invoice_disputed",
  },
};

async function acknowledgeUnownedSubscriptionEvent(
  event: Stripe.Event,
  stripeSubscriptionId: string | null,
  reason: string,
): Promise<DrainResult> {
  const incident = UNOWNED_SUBSCRIPTION_INCIDENTS[event.type];
  const opened =
    incident && stripeSubscriptionId
      ? await (
          await import(
            "@elizaos/cloud-shared/lib/services/subscription-event-incidents"
          )
        ).openSubscriptionEventIncident({
          stripeSubscriptionId,
          livemode: event.livemode,
          eventId: event.id,
          eventType: event.type,
          kind: incident.kind,
          severity: incident.severity,
          reason: incident.reason,
        })
      : false;
  logger.info("[Stripe Queue] Subscription event has no lifecycle owner", {
    code: "unhandled_subscription_event",
    eventId: event.id,
    eventType: event.type,
    stripeSubscriptionId,
    reason,
    incident: opened ? incident?.reason : null,
  });
  return "ack";
}

/** Recognised permanent lifecycle failures; anything else is retryable. */
const PERMANENT_SUBSCRIPTION_FAILURES: Record<string, readonly string[]> = {
  SUBSCRIPTION_LIFECYCLE_REOBSERVE: [
    "unknown_subscription",
    "out_of_order_event_requires_reconciliation",
    "unsupported_event_authority",
    "queue_identity_mismatch",
    "deployment_environment_mismatch",
  ],
  SUBSCRIPTION_RENEWAL_UNAVAILABLE: [
    "unsupported_event_shape",
    "event_identity_mismatch",
    "unknown_subscription",
    "invoice_subscription_unavailable",
    "initial_checkout_ambiguous",
    "initial_checkout_invoice_mismatch",
    "initial_invoice_reason_mismatch",
    "new_stale_invoice_requires_reconciliation",
  ],
  SUBSCRIPTION_DUNNING_UNAVAILABLE: [
    "out_of_order_event_requires_reconciliation",
  ],
  // An active update for a source in dunning is settled by invoice.paid or recovery.
  SUBSCRIPTION_CANCELLATION_REOBSERVE: ["unsupported_current_authority"],
};

/**
 * Branches on typed lifecycle errors: permanent failures and parse failures
 * are acknowledged (recovery reconciles the source), policy failures also open
 * an incident (paid renewal opens its own), everything else retries.
 */
async function classifySubscriptionFailure(
  delivery: StripeEventDelivery,
  stripeSubscriptionId: string | null,
  error: unknown,
): Promise<DrainResult> {
  const { event } = delivery.body;
  const failure = typedFailure(error);
  const context = {
    eventId: event.id,
    eventType: event.type,
    attempts: delivery.attempts,
    stripeSubscriptionId,
    code: failure?.code ?? (error instanceof ZodError ? "ZOD_ERROR" : null),
    reason: failure?.reason ?? null,
  };
  if (error instanceof ZodError) {
    logger.warn(
      "[Stripe Queue] Subscription event payload is unparseable; acknowledging",
      { ...context, issues: error.issues.map((issue) => issue.path.join(".")) },
    );
    return "ack";
  }
  const policyReason = subscriptionPolicyFailureReason(error);
  if (policyReason) {
    try {
      if (
        stripeSubscriptionId &&
        failure?.code !== "SUBSCRIPTION_RENEWAL_UNAVAILABLE"
      )
        await (
          await import(
            "@elizaos/cloud-shared/lib/services/subscription-event-incidents"
          )
        ).openSubscriptionEventIncident({
          stripeSubscriptionId,
          livemode: event.livemode,
          eventId: event.id,
          eventType: event.type,
          kind: "provider_drift",
          severity: "error",
          reason: policyReason,
        });
    } catch (incidentError) {
      // error-policy:J1 Without a durable incident the delivery must stay retryable.
      logger.error(
        "[Stripe Queue] Subscription policy incident could not be recorded; retaining delivery",
        {
          ...context,
          error:
            incidentError instanceof Error
              ? incidentError.message
              : String(incidentError),
        },
      );
      return "retry";
    }
    logger.warn(
      "[Stripe Queue] Subscription observation requires unsupported policy; acknowledged with incident",
      { ...context, policyReason },
    );
    return "ack";
  }
  if (
    failure?.reason &&
    PERMANENT_SUBSCRIPTION_FAILURES[failure.code]?.includes(failure.reason)
  ) {
    logger.warn(
      "[Stripe Queue] Subscription event cannot be applied by this delivery; acknowledging for recovery",
      context,
    );
    return "ack";
  }
  // error-policy:J1 Unrecognised lifecycle failures remain retryable regardless of error wording.
  logger.error(
    "[Stripe Queue] Subscription lifecycle failed; retaining delivery",
    {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    },
  );
  return "retry";
}

/** Signed payloads outside the pinned version may drop fields the owners read from provider retrievals. */
function warnOnUnexpectedApiVersion(event: Stripe.Event): void {
  if (event.api_version && event.api_version !== STRIPE_API_VERSION)
    logger.warn(
      "[Stripe Queue] Subscription event signed with an unexpected API version",
      {
        code: "unexpected_stripe_api_version",
        eventId: event.id,
        eventType: event.type,
        apiVersion: event.api_version,
        pinnedApiVersion: STRIPE_API_VERSION,
      },
    );
}

async function reconcileUpgradeTarget(
  delivery: StripeEventDelivery,
  live: unknown,
) {
  const { reconcileOrganizationUpgradeSubscriptionEvent } = await import(
    "@elizaos/cloud-shared/lib/services/organization-upgrade-subscription-event"
  );
  return reconcileOrganizationUpgradeSubscriptionEvent(delivery.body, live);
}

/** Capture is independently durable, but never converts a failed current lifecycle into success. */
async function reconcileLifecycleWithUpgradeEvidence(
  delivery: StripeEventDelivery,
  live: unknown,
  reconcileLifecycle: () => Promise<unknown>,
) {
  let failure: { error: unknown } | null = null;
  try {
    await reconcileLifecycle();
  } catch (error) {
    failure = { error };
  }
  try {
    await reconcileUpgradeTarget(delivery, live);
  } catch (error) {
    if (failure)
      throw new AggregateError(
        [failure.error, error],
        "Current lifecycle and original upgrade evidence both require reconciliation",
      );
    throw error;
  }
  if (failure) throw failure.error;
}

/**
 * Owns organization subscription deliveries. Routes on the live Stripe status
 * (fetched once here; each owner re-retrieves after capturing its revisions),
 * never on the possibly stale payload status. Returns null for non-recurring
 * deliveries, which continue to purchased-credit fulfillment.
 */
async function processSubscriptionEvent(
  delivery: StripeEventDelivery,
): Promise<DrainResult | null> {
  const { event } = delivery.body;
  let stripeSubscriptionId: string | null = null;
  try {
    if (
      event.type === "checkout.session.completed" &&
      event.data.object.mode === "subscription"
    ) {
      const { reconcileSubscriptionCheckout } = await import(
        "@elizaos/cloud-shared/lib/services/subscription-checkout"
      );
      await reconcileSubscriptionCheckout(event.data.object.id);
      return "ack";
    }
    if (event.type === "customer.subscription.deleted") {
      warnOnUnexpectedApiVersion(event);
      stripeSubscriptionId = event.data.object.id;
      await reconcileStripeTerminalLifecycle(delivery.body);
      return "ack";
    }
    if (event.type === "customer.subscription.updated") {
      warnOnUnexpectedApiVersion(event);
      stripeSubscriptionId = event.data.object.id;
      const live =
        await requireStripe().subscriptions.retrieve(stripeSubscriptionId);
      switch (live.status) {
        case "canceled":
        case "incomplete_expired":
          await reconcileLifecycleWithUpgradeEvidence(delivery, live, () =>
            reconcileStripeTerminalLifecycle(delivery.body),
          );
          return "ack";
        case "past_due":
        case "unpaid":
          await reconcileLifecycleWithUpgradeEvidence(
            delivery,
            live,
            async () =>
              (
                await import(
                  "@elizaos/cloud-shared/lib/services/stripe-dunning-lifecycle"
                )
              ).reconcileStripeDunningLifecycle(
                delivery.body,
                event.data.object.id,
              ),
          );
          return "ack";
        case "active":
          if (
            live.cancel_at_period_end ||
            live.cancel_at !== null ||
            live.schedule !== null ||
            live.pause_collection !== null
          ) {
            await reconcileLifecycleWithUpgradeEvidence(delivery, live, () =>
              reconcileStripeScheduledCancellationLifecycle(delivery.body),
            );
            return "ack";
          }
          if ((await reconcileUpgradeTarget(delivery, live)).owned)
            return "ack";
          await reconcileStripeScheduledCancellationLifecycle(delivery.body);
          return "ack";
        default:
          await reconcileUpgradeTarget(delivery, live);
          return await acknowledgeUnownedSubscriptionEvent(
            event,
            stripeSubscriptionId,
            `live_status_${live.status}`,
          );
      }
    }
    if (event.type === "customer.subscription.pending_update_applied") {
      stripeSubscriptionId = event.data.object.id;
      const live =
        await requireStripe().subscriptions.retrieve(stripeSubscriptionId);
      if ((await reconcileUpgradeTarget(delivery, live)).owned) return "ack";
      return acknowledgeUnownedSubscriptionEvent(
        event,
        stripeSubscriptionId,
        "pending_update_not_owned",
      );
    }
    if (
      (event.type === "invoice.created" || event.type === "invoice.paid") &&
      event.data.object.billing_reason === "subscription_update"
    ) {
      stripeSubscriptionId = invoiceSubscriptionId(event.data.object);
      const { reconcileOrganizationUpgradeInvoiceEvent } = await import(
        "@elizaos/cloud-shared/lib/services/organization-upgrade-invoice-event"
      );
      const result = await reconcileOrganizationUpgradeInvoiceEvent(
        delivery.body,
      );
      if (result.owned) return "ack";
      return await acknowledgeUnownedSubscriptionEvent(
        event,
        stripeSubscriptionId,
        "original_upgrade_command_unavailable",
      );
    }
    if (
      event.type === "invoice.paid" &&
      isRecurringInvoice(event.data.object)
    ) {
      warnOnUnexpectedApiVersion(event);
      stripeSubscriptionId = invoiceSubscriptionId(event.data.object);
      const { reconcileStripePaidRenewal } = await import(
        "@elizaos/cloud-shared/lib/services/stripe-paid-renewal"
      );
      await reconcileStripePaidRenewal(delivery.body);
      return "ack";
    }
    if (
      event.type === "invoice.payment_failed" &&
      isRecurringInvoice(event.data.object)
    ) {
      warnOnUnexpectedApiVersion(event);
      // Basil payloads omit invoice.subscription; the pinned client's invoice carries it.
      const invoice = await requireStripe().invoices.retrieve(
        event.data.object.id,
      );
      stripeSubscriptionId = invoiceSubscriptionId(invoice);
      if (!stripeSubscriptionId)
        return await acknowledgeUnownedSubscriptionEvent(
          event,
          null,
          "invoice_subscription_unavailable",
        );
      const live =
        await requireStripe().subscriptions.retrieve(stripeSubscriptionId);
      if (live.status === "past_due" || live.status === "unpaid") {
        await (
          await import(
            "@elizaos/cloud-shared/lib/services/stripe-dunning-lifecycle"
          )
        ).reconcileStripeDunningLifecycle(delivery.body, stripeSubscriptionId);
        return "ack";
      }
      // Active: Stripe has not entered dunning; incomplete: the initial
      // payment belongs to checkout; canceled: the terminal event owns it.
      return await acknowledgeUnownedSubscriptionEvent(
        event,
        stripeSubscriptionId,
        `no_owned_change_live_status_${live.status}`,
      );
    }
    const linkage = await classifySubscriptionLinkage(event);
    if (linkage.kind === "ambiguous") {
      logger.error(
        "[Stripe Queue] Subscription linkage unavailable; retaining delivery",
        {
          eventId: event.id,
          eventType: event.type,
          attempts: delivery.attempts,
          code: "SUBSCRIPTION_RECONCILIATION_UNAVAILABLE",
        },
      );
      return "retry";
    }
    if (linkage.kind === "recurring") {
      warnOnUnexpectedApiVersion(event);
      stripeSubscriptionId = linkage.stripeSubscriptionId;
      return await acknowledgeUnownedSubscriptionEvent(
        event,
        stripeSubscriptionId,
        "no_lifecycle_owner",
      );
    }
    return null;
  } catch (error) {
    return classifySubscriptionFailure(delivery, stripeSubscriptionId, error);
  }
}

/**
 * Process a single Stripe event message.
 *
 * Returns `ack` on success and permanent failures (bad data we cannot
 * recover by retrying). Returns `retry` on transient failures so the Redis
 * queue helper can redeliver until maxAttempts is exhausted.
 */
export async function processStripeEvent(
  delivery: StripeEventDelivery,
): Promise<DrainResult> {
  if (delivery.body.appBilling) {
    try {
      const { appBillingReconciliation } = await import(
        "@elizaos/cloud-shared/lib/services/app-billing-reconciliation"
      );
      await appBillingReconciliation.processPersisted(
        delivery.body.appBilling.receiptKey,
        delivery.body.appBilling.trigger,
      );
      return "ack";
    } catch (error) {
      // error-policy:J4 Generic billing retains the intake and receipt for retry; legacy message-text heuristics cannot acknowledge it.
      logger.error("[Stripe Queue] App subscription reconciliation failed", {
        eventId: delivery.body.eventId,
        errorType: error instanceof Error ? error.name : "unknown",
        attempts: delivery.attempts,
      });
      return "retry";
    }
  }
  const { event } = delivery.body;
  logger.info(
    `[Stripe Queue] Processing ${event.type} (${event.id}) attempt=${delivery.attempts}`,
  );

  const subscriptionResult = await processSubscriptionEvent(delivery);
  if (subscriptionResult !== null) return subscriptionResult;

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(event);
        break;
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(event);
        break;
      case "payment_intent.payment_failed":
        await handlePaymentIntentFailed(event);
        break;
      case "charge.refunded":
        await handleChargeRefunded(event);
        break;
      case "charge.dispute.funds_withdrawn":
        await handleChargeDisputeFundsWithdrawn(event);
        break;
      case "charge.dispute.funds_reinstated":
        await handleChargeDisputeFundsReinstated(event);
        break;
      case "charge.dispute.closed":
        await handleChargeDisputeClosed(event);
        break;
      default:
        logger.debug(`[Stripe Queue] Unhandled event type: ${event.type}`);
    }
    return "ack";
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Permanent errors: bad data we cannot recover by retrying. Ack so
    // the DLQ does not collect noise from poisonous metadata.
    const isPermanentError =
      error instanceof Error &&
      (error.message.includes("not found") ||
        error.message.includes("Invalid") ||
        error.message.includes("already processed"));

    if (isPermanentError) {
      logger.warn(
        `[Stripe Queue] Permanent failure for ${event.type} (${event.id}); acking to skip retries`,
        { error: errorMessage },
      );
      return "ack";
    }

    logger.error(
      `[Stripe Queue] Transient failure for ${event.type} (${event.id}); retrying`,
      {
        error: errorMessage,
        attempts: delivery.attempts,
      },
    );
    return "retry";
  }
}

// ---------------------------------------------------------------------------
// checkout.session.completed
// ---------------------------------------------------------------------------

async function handleCheckoutSessionCompleted(
  event: Stripe.Event,
): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.mode !== "payment" || session.payment_status !== "paid") return;

  const retiredMiniapp = retiredMiniappPayment(session.metadata);
  if (retiredMiniapp) {
    await acknowledgeRetiredMiniappPayment(event, session.id, retiredMiniapp);
    return;
  }

  let organizationId = session.metadata?.organization_id;
  let userId = session.metadata?.user_id;
  const creditsStr = session.metadata?.credits || "0";
  let credits = parseAndValidateCredits(creditsStr);
  let purchaseAmountUsd = credits;
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);
  let purchaseType = session.metadata?.type || "checkout";
  const appId = session.metadata?.app_id;
  const agentId = session.metadata?.agent_id;
  const checkoutOrderId = session.metadata?.checkout_order_id;

  if (!paymentIntentId) {
    logger.warn(
      `[Stripe Queue] Permanent failure - No payment intent ID in checkout session ${session.id}`,
    );
    return;
  }

  let durableAlreadyApplied = false;
  let legacyCutoverApplied = false;
  let legacyAlreadyApplied = false;
  if (checkoutOrderId) {
    const settlement = await stripeCheckoutOrdersService.settle(
      projectStripeCheckoutReceipt(session, paymentIntentId, checkoutOrderId),
    );
    organizationId = settlement.order.organization_id;
    userId = settlement.order.initiated_by_user_id;
    credits = Number(settlement.order.credits_to_grant);
    purchaseAmountUsd = Number(settlement.order.charge_amount_cents) / 100;
    purchaseType = settlement.order.purchase_type;
    durableAlreadyApplied = settlement.alreadyApplied;
  } else if (
    purchaseType === "custom_amount" ||
    purchaseType === "credit_pack"
  ) {
    const settlement = await stripeCheckoutOrdersService.settleLegacy(
      projectLegacyStripeCheckoutReceipt(session, paymentIntentId),
    );
    organizationId = settlement.organizationId;
    userId = settlement.initiatedByUserId;
    purchaseType = settlement.purchaseType;
    credits = Number(settlement.creditsToGrant);
    purchaseAmountUsd = (session.amount_total ?? 0) / 100;
    legacyCutoverApplied = true;
    legacyAlreadyApplied = settlement.alreadyApplied;
  }

  if (!organizationId || !credits || !purchaseAmountUsd) {
    logger.warn(
      `[Stripe Queue] Permanent failure - Invalid checkout authority for session ${session.id}`,
      {
        hasOrgId: !!organizationId,
        hasValidCredits: !!credits,
        hasCheckoutOrder: !!checkoutOrderId,
      },
    );
    return;
  }

  const existingTransaction =
    checkoutOrderId || legacyCutoverApplied
      ? null
      : await creditsService.getTransactionByStripePaymentIntent(
          paymentIntentId,
        );
  const isDuplicate = checkoutOrderId
    ? durableAlreadyApplied
    : legacyCutoverApplied
      ? legacyAlreadyApplied
      : !!existingTransaction;

  if (isDuplicate) {
    logger.debug(
      `[Stripe Queue] Per-row dedup hit - Payment intent ${paymentIntentId} already credited; will still attempt revenue splits (idempotent via dedupeBySourceId)`,
    );
  }

  if (!checkoutOrderId && !legacyCutoverApplied && !isDuplicate) {
    await creditsService.addCredits({
      organizationId,
      amount: credits,
      description: `Balance top-up - $${credits.toFixed(2)}`,
      metadata: {
        user_id: userId,
        payment_intent_id: paymentIntentId,
        session_id: session.id,
        type: purchaseType,
        ...(agentId ? { agent_id: agentId } : {}),
      },
      stripePaymentIntentId: paymentIntentId,
    });

    logger.info(
      `[Stripe Queue] Credits added: ${credits} to org ${organizationId}`,
    );

    if (agentId) {
      await notifyWaifuCreditsToppedUp({
        agentId,
        eventId: `stripe:${event.id}:credits.topped_up:${agentId}`,
        credits,
        paymentIntentId,
        sessionId: session.id,
      });
    }

    invalidateOrgTierCache(organizationId).catch((err) =>
      logger.warn("[Stripe Queue] Failed to invalidate org tier cache", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  } else if (checkoutOrderId || legacyCutoverApplied) {
    logger.info(
      `[Stripe Queue] ${checkoutOrderId ? `Durable Checkout order ${checkoutOrderId}` : `Legacy Checkout session ${session.id}`} ${isDuplicate ? "was already" : "is now"} settled`,
      { organizationId, paymentIntentId },
    );
    if (agentId) {
      await notifyWaifuCreditsToppedUp({
        agentId,
        eventId: `stripe:${event.id}:credits.topped_up:${agentId}:${isDuplicate ? "already_applied" : "settled"}`,
        credits,
        paymentIntentId,
        sessionId: session.id,
      });
    }
    invalidateOrgTierCache(organizationId).catch((err) =>
      logger.warn("[Stripe Queue] Failed to invalidate org tier cache", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  } else if (agentId) {
    await notifyWaifuCreditsToppedUp({
      agentId,
      eventId: `stripe:${event.id}:credits.topped_up:${agentId}:already_applied`,
      credits,
      paymentIntentId,
      sessionId: session.id,
    });
  }

  // A top-up repays any outstanding reversal shortfall first (#22930). Runs on
  // every delivery so a crash between the grant and this step is repaired.
  const stillHeld = await settleShortfallsAfterCredit(
    organizationId,
    "checkout.session.completed",
  );

  if (agentId && stillHeld) {
    logger.info(
      "[Stripe Queue] Agent restart skipped after top-up: billing hold still active",
      { agentId, organizationId, paymentIntentId },
    );
  } else if (agentId) {
    await enqueueAgentRestartAfterTopUp({
      agentId,
      organizationId,
      userId,
      paymentIntentId,
      sessionId: session.id,
    });
  }

  // Revenue splits run on every delivery (including duplicate event_id
  // hits at the per-row level) so a retry that previously failed mid-way
  // can complete. dedupeBySourceId guarantees we never insert twice.
  if (userId) {
    const { splits } = await referralsService.calculateRevenueSplits(
      userId,
      purchaseAmountUsd,
    );
    if (splits.length > 0) {
      logger.info(
        `[Stripe Queue] Processing revenue splits for $${purchaseAmountUsd.toFixed(2)} purchase by user ${userId}`,
      );
      for (const split of splits) {
        if (split.amount <= 0) continue;
        const source =
          split.role === "app_owner"
            ? "app_owner_revenue_share"
            : "creator_revenue_share";
        try {
          await redeemableEarningsService.addEarnings({
            userId: split.userId,
            amount: split.amount,
            source,
            sourceId: `revenue_split:${paymentIntentId}:${split.userId}`,
            dedupeBySourceId: true,
            description: `${
              split.role === "app_owner" ? "App Owner" : "Creator"
            } revenue share (${((split.amount / purchaseAmountUsd) * 100).toFixed(0)}%) for $${purchaseAmountUsd.toFixed(2)} purchase`,
            metadata: {
              buyer_user_id: userId,
              buyer_org_id: organizationId,
              payment_intent_id: paymentIntentId,
              role: split.role,
            },
          });
          logger.info(
            `[Stripe Queue] Credited split: $${split.amount.toFixed(2)} to ${split.role} (${split.userId})`,
          );
        } catch (splitError) {
          // Surface as transient — the queue will retry. dedupeBySourceId
          // guarantees a successful split on a previous attempt is not
          // re-applied on retry.
          logger.error(
            `[Stripe Queue] Failed to credit split to ${split.role} (${split.userId})`,
            {
              error:
                splitError instanceof Error
                  ? splitError.message
                  : String(splitError),
              amount: split.amount,
              paymentIntentId,
              sourceId: `revenue_split:${paymentIntentId}:${split.userId}`,
            },
          );
          throw splitError instanceof Error
            ? splitError
            : new Error(String(splitError));
        }
      }
    }
  }

  if (!isDuplicate) {
    organizationsRepository.findById(organizationId).then((org) => {
      const user = userId
        ? usersRepository.findById(userId)
        : Promise.resolve(null);
      user.then((userData) => {
        discordService
          .logPaymentReceived({
            paymentId: paymentIntentId,
            amount: purchaseAmountUsd,
            currency: session.currency || "usd",
            credits,
            organizationId,
            organizationName: org?.name,
            userId: userId || undefined,
            userName: userData?.name || userData?.email,
            paymentMethod: "stripe",
            paymentType:
              purchaseType === "credit_pack" ? "Credit Pack" : "Balance Top-up",
          })
          .catch((err) => {
            logger.error("[Stripe Queue] Failed to log payment to Discord", {
              error: err,
            });
          });
      });
    });
  }

  if (!isDuplicate || checkoutOrderId || legacyCutoverApplied) {
    try {
      const existingInvoice = await invoicesService.getByStripeInvoiceId(
        `cs_${session.id}`,
      );

      if (!existingInvoice) {
        const amountTotal = session.amount_total
          ? (session.amount_total / 100).toString()
          : credits.toString();

        await invoicesService.create({
          organization_id: organizationId,
          stripe_invoice_id: `cs_${session.id}`,
          stripe_customer_id: session.customer as string,
          stripe_payment_intent_id: paymentIntentId,
          amount_due: amountTotal,
          amount_paid: amountTotal,
          currency: session.currency || "usd",
          status: "paid",
          invoice_type: purchaseType,
          invoice_number: undefined,
          invoice_pdf: undefined,
          hosted_invoice_url: undefined,
          credits_added: credits.toString(),
          metadata: {
            type: purchaseType,
            session_id: session.id,
            ...(appId && { app_id: appId }),
            ...(agentId && { agent_id: agentId }),
          },
          paid_at: new Date(),
        });

        logger.debug(
          `[Stripe Queue] Invoice created for checkout session ${session.id}`,
        );
      } else {
        logger.debug(
          `[Stripe Queue] Invoice already exists for checkout session ${session.id}`,
        );
      }
    } catch (invoiceError) {
      logger.error(
        "[Stripe Queue] Error creating invoice record",
        invoiceError,
      );
      // The authoritative Checkout settlement is replay-safe, so retry to
      // recover a projection failure that happened after the credit commit.
      if (checkoutOrderId || legacyCutoverApplied) throw invoiceError;
    }
  }
}

async function enqueueAgentRestartAfterTopUp(params: {
  agentId: string;
  organizationId: string;
  userId?: string;
  paymentIntentId: string;
  sessionId: string;
}): Promise<void> {
  if (!params.userId) {
    logger.warn(
      "[Stripe Queue] Agent top-up has no user_id; skipping restart enqueue",
      {
        agentId: params.agentId,
        organizationId: params.organizationId,
        paymentIntentId: params.paymentIntentId,
        sessionId: params.sessionId,
      },
    );
    return;
  }

  try {
    await provisioningJobService.enqueueAgentRestartOnce({
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
    });
  } catch (error) {
    // error-policy:J1 the payment boundary translates only the authoritative,
    // locked non-container target rejection into the designed no-restart outcome.
    if (
      !(
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === "session_not_ready" &&
        error.details?.reason === CONTAINER_BACKED_TARGET_REJECTION_REASON &&
        error.details.jobType === JOB_TYPES.AGENT_RESTART
      )
    ) {
      throw error;
    }
    logger.info(
      "[Stripe Queue] Agent top-up targets a non-container-backed tier; restart skipped",
      {
        agentId: params.agentId,
        organizationId: params.organizationId,
        paymentIntentId: params.paymentIntentId,
        sessionId: params.sessionId,
      },
    );
    return;
  }
  void provisioningJobService.triggerImmediate().catch((err) =>
    // error-policy:J5 The durable restart job remains observable by the scheduled poller;
    // this handler observes and reports only the failed best-effort immediate nudge.
    logger.warn(
      "[Stripe Queue] provisioning triggerImmediate nudge failed after agent top-up",
      {
        agentId: params.agentId,
        organizationId: params.organizationId,
        paymentIntentId: params.paymentIntentId,
        error: err instanceof Error ? err.message : String(err),
      },
    ),
  );
  logger.info("[Stripe Queue] Agent restart enqueued after credit top-up", {
    agentId: params.agentId,
    organizationId: params.organizationId,
    paymentIntentId: params.paymentIntentId,
  });
}

async function notifyWaifuCreditsToppedUp(params: {
  agentId: string;
  eventId: string;
  credits: number;
  paymentIntentId: string;
  sessionId: string;
}): Promise<void> {
  const [sandbox] = await dbRead
    .select({
      id: agentSandboxes.id,
      organizationId: agentSandboxes.organization_id,
      agent_config: agentSandboxes.agent_config,
      status: agentSandboxes.status,
      billing_status: agentSandboxes.billing_status,
    })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, params.agentId))
    .limit(1);
  if (!sandbox) return;

  const config = recordFromUnknown(sandbox.agent_config);
  const waifuWebhook = recordFromUnknown(config.waifuWebhook);
  const webhookUrl =
    stringField(config, "webhookUrl") ?? stringField(waifuWebhook, "url");
  const webhookSecret =
    stringField(config, "webhookSecret") ??
    stringField(waifuWebhook, "secret") ??
    process.env.ELIZA_CLOUD_WEBHOOK_SECRET ??
    process.env.WAIFU_WEBHOOK_SECRET;
  if (!webhookUrl || !webhookSecret) return;

  const timestamp = new Date().toISOString();
  const account = recordFromUnknown(config.account);
  const body = JSON.stringify({
    event: "credits.topped_up",
    timestamp,
    eventId: params.eventId,
    elizaCloudAgentId: sandbox.id,
    agentId: sandbox.id,
    organizationId: sandbox.organizationId,
    tokenContractAddress: stringField(config, "tokenContractAddress"),
    tokenAddress: stringField(config, "tokenContractAddress"),
    tokenChain: stringField(config, "chain"),
    chain: stringField(config, "chain"),
    chainId: numberField(config, "chainId"),
    primaryWalletAddress: stringField(account, "primaryWalletAddress"),
    walletKeyRef: stringField(account, "walletKeyRef"),
    amount: params.credits,
    amountUsd: params.credits,
    paymentIntentId: params.paymentIntentId,
    sessionId: params.sessionId,
    billingStatus: sandbox.billing_status,
    status: sandbox.status,
  });
  const signature = `sha256=${createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;

  try {
    // SECURITY (#9853): webhookUrl is DB-stored per-agent config — IP-pin it so
    // a malicious receiver URL can't pivot into internal/metadata networks.
    const response = await safeFetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Waifu-Webhook-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.warn("[Stripe Queue] Waifu credit top-up webhook failed", {
        agentId: params.agentId,
        status: response.status,
      });
    }
  } catch (error) {
    logger.warn("[Stripe Queue] Waifu credit top-up webhook error", {
      agentId: params.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(
  data: Record<string, unknown>,
  key: string,
): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberField(
  data: Record<string, unknown>,
  key: string,
): number | null {
  const value = data[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Retired mini-app payments
// ---------------------------------------------------------------------------

interface RetiredMiniappPayment {
  appId: string | null;
  chargeRequestId: string | null;
  source: string | null;
  type: string | null;
}

/**
 * Mini-app charges and app credit purchases were removed from the product
 * (#32021). Their Checkout sessions and PaymentIntents carried
 * `charge_request_id`, `source`/`purchase_source` = "miniapp_app", or
 * `type` = "app_credit_purchase" alongside `organization_id` + `credits`.
 * A late or replayed delivery must not fall through to generic org credit
 * fulfillment: the retired lane may already have credited the payer.
 * `app_id` alone is not a marker — live payment requests carry it too.
 */
function retiredMiniappPayment(
  metadata: Stripe.Metadata | null | undefined,
): RetiredMiniappPayment | null {
  const data = recordFromUnknown(metadata);
  const chargeRequestId = stringField(data, "charge_request_id");
  const source =
    stringField(data, "source") ?? stringField(data, "purchase_source");
  const type = stringField(data, "type");
  if (
    !chargeRequestId &&
    source !== "miniapp_app" &&
    stringField(data, "purchase_source") !== "miniapp_app" &&
    type !== "app_credit_purchase"
  ) {
    return null;
  }
  return {
    appId: stringField(data, "app_id"),
    chargeRequestId,
    source,
    type,
  };
}

/**
 * Acknowledge a retired mini-app payment without any financial side effect.
 * The structured error log and ops warning are the operator signal; the
 * payment needs manual reconciliation (refund or support credit) if it was
 * never fulfilled by the retired lane.
 */
async function acknowledgeRetiredMiniappPayment(
  event: Stripe.Event,
  objectId: string,
  retired: RetiredMiniappPayment,
): Promise<void> {
  const context = {
    code: "retired_miniapp_payment",
    eventId: event.id,
    eventType: event.type,
    objectId,
    livemode: event.livemode,
    appId: retired.appId,
    chargeRequestId: retired.chargeRequestId,
    source: retired.source,
    type: retired.type,
  };
  logger.error(
    "[Stripe Queue] Retired mini-app payment acknowledged without fulfillment",
    context,
  );
  try {
    await discordService.logWarning({
      title: "Retired mini-app payment received",
      message:
        "A Stripe payment carrying retired mini-app metadata was acknowledged without crediting. Reconcile it manually.",
      context,
    });
  } catch (error) {
    // error-policy:J6 The structured error log above is the durable signal;
    // an ops-channel outage must not turn the acknowledgement into a retry.
    logger.warn("[Stripe Queue] Retired mini-app payment warning not sent", {
      eventId: event.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// payment_intent.succeeded
// ---------------------------------------------------------------------------

async function handlePaymentIntentSucceeded(
  event: Stripe.Event,
): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  logger.debug(`[Stripe Queue] Payment intent succeeded: ${paymentIntent.id}`);

  const retiredMiniapp = retiredMiniappPayment(paymentIntent.metadata);
  if (retiredMiniapp) {
    await acknowledgeRetiredMiniappPayment(
      event,
      paymentIntent.id,
      retiredMiniapp,
    );
    return;
  }

  // One-time and auto-top-up use PaymentIntent directly (no checkout
  // session). Referral splits run only for checkout.session.completed —
  // affiliate markup is applied when the PaymentIntent is created, so
  // the only payout here is the auto-top-up affiliate fee.
  const purchaseType = paymentIntent.metadata?.type;
  if (
    paymentIntent.metadata?.checkout_order_id ||
    purchaseType === "custom_amount" ||
    purchaseType === "credit_pack"
  ) {
    logger.debug(
      `[Stripe Queue] Skipping Checkout-owned payment intent ${paymentIntent.id}; checkout.session.completed owns fulfillment`,
    );
    return;
  }
  const hasDurableAutoTopUpMarker = Object.hasOwn(
    paymentIntent.metadata ?? {},
    "auto_top_up_attempt_id",
  );
  const durableAttemptId = paymentIntent.metadata?.auto_top_up_attempt_id;

  if (
    !hasDurableAutoTopUpMarker &&
    (!purchaseType || purchaseType === "credit_pack")
  ) {
    logger.debug(
      `[Stripe Queue] Skipping payment intent ${paymentIntent.id} - type: ${purchaseType || "unknown"}`,
    );
    return;
  }

  const isDurableAutoTopUp = hasDurableAutoTopUpMarker;

  if (isDurableAutoTopUp) {
    // Durable reconciliation validates and settles the signed receipt before
    // this consumer may project any payout or invoice side effect.
    let reconciliation: Awaited<
      ReturnType<typeof autoTopUpService.reconcileSucceededPaymentIntent>
    >;
    try {
      reconciliation =
        await autoTopUpService.reconcileSucceededPaymentIntent(paymentIntent);
    } catch (cause) {
      // error-policy:J2 A missing or unavailable durable attempt must exhaust
      // queue retries and reach the DLQ, never be mistaken for bad metadata.
      throw new Error("Durable auto-top-up reconciliation failed", { cause });
    }
    if (reconciliation.disposition === "rejected") {
      logger.warn(
        `[Stripe Queue] Durable auto top-up ${durableAttemptId || "invalid-attempt-id"} rejected payment intent ${paymentIntent.id}; skipping financial side effects`,
        {
          attemptId: durableAttemptId,
          status: reconciliation.result.status,
        },
      );
      return;
    }
    if (reconciliation.disposition === "validated_deferred") {
      logger.warn(
        `[Stripe Queue] Durable auto top-up ${durableAttemptId || "invalid-attempt-id"} validated payment intent ${paymentIntent.id} but settlement is deferred; retrying without projections`,
        {
          attemptId: durableAttemptId,
          status: reconciliation.result.status,
        },
      );
      // error-policy:J2 Preserve the signed receipt in the retry/DLQ lane;
      // only a settled attempt may project affiliate earnings or an invoice.
      throw new Error("Durable auto-top-up settlement is deferred");
    }
  }

  const organizationId = paymentIntent.metadata?.organization_id;
  const creditsStr = paymentIntent.metadata?.credits;
  const credits = creditsStr ? parseAndValidateCredits(creditsStr) : null;

  if (!organizationId || !credits) {
    logger.warn(
      `[Stripe Queue] Permanent failure - Invalid metadata in payment intent ${paymentIntent.id}`,
      { hasOrgId: !!organizationId, hasValidCredits: !!credits },
    );
    return;
  }

  const affiliateFeeStr = paymentIntent.metadata?.affiliate_fee_amount;
  const affiliateFeeAmount = affiliateFeeStr
    ? Number.parseFloat(affiliateFeeStr)
    : 0;
  const affiliateOwnerId = paymentIntent.metadata?.affiliate_owner_id;
  const affiliateCodeId = paymentIntent.metadata?.affiliate_code_id;

  if (
    affiliateFeeStr &&
    (!Number.isFinite(affiliateFeeAmount) || affiliateFeeAmount < 0)
  ) {
    logger.warn(
      `[Stripe Queue] Permanent failure - Invalid affiliate metadata in payment intent ${paymentIntent.id}`,
      { affiliateFeeStr },
    );
    return;
  }

  const existingTransaction =
    await creditsService.getTransactionByStripePaymentIntent(paymentIntent.id);
  const isDuplicate = !!existingTransaction;

  if (isDuplicate) {
    logger.debug(
      `[Stripe Queue] Per-row dedup hit - Payment intent ${paymentIntent.id} already credited`,
    );
  }

  const description =
    purchaseType === "auto_top_up"
      ? `Auto top-up - $${credits.toFixed(2)}`
      : `One-time purchase - $${credits.toFixed(2)}`;

  if (!isDuplicate && !isDurableAutoTopUp) {
    await creditsService.addCredits({
      organizationId,
      amount: credits,
      description,
      metadata: {
        type: purchaseType,
        payment_intent_id: paymentIntent.id,
      },
      stripePaymentIntentId: paymentIntent.id,
    });

    logger.info(
      `[Stripe Queue] Credits added: ${credits} to org ${organizationId} (${purchaseType})`,
    );
    await settleShortfallsAfterCredit(
      organizationId,
      "payment_intent.succeeded",
    );

    invalidateOrgTierCache(organizationId).catch((err) =>
      logger.warn("[Stripe Queue] Failed to invalidate org tier cache", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    organizationsRepository.findById(organizationId).then((org) => {
      discordService
        .logPaymentReceived({
          paymentId: paymentIntent.id,
          amount: credits,
          currency: paymentIntent.currency,
          credits,
          organizationId,
          organizationName: org?.name,
          paymentMethod: "stripe",
          paymentType:
            purchaseType === "auto_top_up"
              ? "Auto Top-up"
              : "One-time Purchase",
        })
        .catch((err) => {
          logger.error("[Stripe Queue] Failed to log payment to Discord", {
            error: err,
          });
        });
    });
  }

  if (
    purchaseType === "auto_top_up" &&
    affiliateFeeAmount > 0 &&
    affiliateOwnerId &&
    affiliateCodeId
  ) {
    const result = await redeemableEarningsService.addEarnings({
      userId: affiliateOwnerId,
      amount: affiliateFeeAmount,
      source: "affiliate",
      sourceId: `affiliate_auto_topup:${paymentIntent.id}:${affiliateCodeId}`,
      dedupeBySourceId: true,
      description: `Auto top-up affiliate fee for $${credits.toFixed(2)} purchase`,
      metadata: {
        buyer_user_id: paymentIntent.metadata?.user_id,
        buyer_org_id: organizationId,
        payment_intent_id: paymentIntent.id,
        total_charged: paymentIntent.metadata?.total_charged,
      },
    });

    if (!result.success) {
      logger.error(
        `[Stripe Queue] Failed to credit auto top-up affiliate payout for ${paymentIntent.id}`,
        { error: result.error, affiliateOwnerId, affiliateCodeId },
      );
      throw new Error(
        `Failed to process auto top-up affiliate payout: ${result.error}`,
      );
    }
  }

  // Invoice creation is non-critical. It deliberately runs for duplicate
  // credit rows because synchronous durable settlement may win first.
  // The receipt carries the credited base, affiliate markup, platform fee and
  // total charge from the signed durable metadata (#23020).
  const chargeBreakdown = isDurableAutoTopUp
    ? autoTopUpChargeBreakdownFromMetadata(paymentIntent.metadata)
    : null;
  try {
    const invoiceIdOrObject = (
      paymentIntent as Stripe.PaymentIntent & {
        invoice?: string | Stripe.Invoice | null;
      }
    ).invoice;
    if (invoiceIdOrObject) {
      const invoiceId = isInvoiceExpanded(invoiceIdOrObject)
        ? invoiceIdOrObject.id
        : invoiceIdOrObject;

      const existingInvoice =
        await invoicesService.getByStripeInvoiceId(invoiceId);

      if (!existingInvoice) {
        const stripe = requireStripe();
        const stripeInvoice = await stripe.invoices.retrieve(invoiceId);

        await invoicesService.create({
          organization_id: organizationId,
          stripe_invoice_id: stripeInvoice.id,
          stripe_customer_id: stripeInvoice.customer as string,
          stripe_payment_intent_id: paymentIntent.id,
          amount_due: (stripeInvoice.amount_due / 100).toString(),
          amount_paid: (stripeInvoice.amount_paid / 100).toString(),
          currency: stripeInvoice.currency,
          status: stripeInvoice.status || "draft",
          invoice_type: purchaseType || "one_time_purchase",
          invoice_number: stripeInvoice.number || undefined,
          invoice_pdf: stripeInvoice.invoice_pdf || undefined,
          hosted_invoice_url: stripeInvoice.hosted_invoice_url || undefined,
          credits_added: credits.toString(),
          metadata: {
            type: purchaseType,
            ...(chargeBreakdown && { charge_breakdown: chargeBreakdown }),
          },
          paid_at: stripeInvoice.status_transitions?.paid_at
            ? new Date(stripeInvoice.status_transitions.paid_at * 1000)
            : undefined,
        });

        logger.debug(
          `[Stripe Queue] Invoice created for payment intent ${paymentIntent.id}`,
        );
      }
    } else {
      const existingInvoice = await invoicesService.getByStripeInvoiceId(
        `pi_${paymentIntent.id}`,
      );

      if (!existingInvoice) {
        await invoicesService.create({
          organization_id: organizationId,
          stripe_invoice_id: `pi_${paymentIntent.id}`,
          stripe_customer_id: paymentIntent.customer as string,
          stripe_payment_intent_id: paymentIntent.id,
          amount_due: (paymentIntent.amount / 100).toString(),
          amount_paid: (paymentIntent.amount_received / 100).toString(),
          currency: paymentIntent.currency,
          status: "paid",
          invoice_type: purchaseType || "one_time_purchase",
          invoice_number: undefined,
          invoice_pdf: undefined,
          hosted_invoice_url: undefined,
          credits_added: credits.toString(),
          metadata: {
            type: purchaseType,
            ...(chargeBreakdown && { charge_breakdown: chargeBreakdown }),
          },
          paid_at: new Date(),
        });

        logger.debug(
          `[Stripe Queue] Invoice created for direct payment ${paymentIntent.id}`,
        );
      } else {
        logger.debug(
          `[Stripe Queue] Invoice already exists for payment ${paymentIntent.id}`,
        );
      }
    }
  } catch (invoiceError) {
    logger.error(
      "[Stripe Queue] Non-critical error creating invoice record",
      invoiceError,
    );
    if (isDurableAutoTopUp) {
      // error-policy:J2 Durable settlement can win before this projection.
      // Retry the idempotent queue message instead of permanently losing the
      // invoice that proves the card charge to the organization.
      throw new Error("Durable auto-top-up invoice projection failed", {
        cause: invoiceError,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// payment_intent.payment_failed
// ---------------------------------------------------------------------------

async function handlePaymentIntentFailed(event: Stripe.Event): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const orgId = paymentIntent.metadata?.organization_id;
  const userId = paymentIntent.metadata?.user_id;
  const lastPaymentError = paymentIntent.last_payment_error;
  const errorReason =
    lastPaymentError?.message || lastPaymentError?.code || "Payment failed";

  logger.warn(`[Stripe Queue] Payment intent failed: ${paymentIntent.id}`, {
    paymentIntentId: paymentIntent.id,
    userId,
    organizationId: orgId,
    errorReason,
    ...(retiredMiniappPayment(paymentIntent.metadata)
      ? { code: "retired_miniapp_payment" }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// charge.refunded / charge.dispute.* — credit clawback/reinstatement (#10920, #10997)
// ---------------------------------------------------------------------------

/** The payment intent id off a charge, whether expanded or a bare string. */
function chargePaymentIntentId(charge: Stripe.Charge): string | undefined {
  return typeof charge.payment_intent === "string"
    ? charge.payment_intent
    : charge.payment_intent?.id;
}

/**
 * Claw back org credits for the portion of a top-up charge that Stripe reversed.
 * Durable pack orders and fee-inclusive auto top-ups claw back the exact granted
 * credits in proportion to the reversed provider charge; legacy balance top-ups
 * remain 1:1. Credits are
 * removed up to the original grant and the org's current balance. Any
 * unrecovered portion is recorded on the clawback transaction metadata because
 * the organizations table has a nonnegative balance constraint. Only the DELTA
 * past what was already clawed for this payment intent is removed, so multiple
 * partial refunds and re-delivered webhooks are safe.
 */
async function clawbackForReversal(params: {
  paymentIntentId: string | undefined;
  usdReversed: number;
  idempotencyKey: string;
  source: string;
  reference: string;
}): Promise<void> {
  const { paymentIntentId, usdReversed, idempotencyKey, source, reference } =
    params;
  if (!paymentIntentId || usdReversed <= 0) return;

  // Only top-ups that actually granted org credits are clawable.
  const grant =
    await creditsService.getTransactionByStripePaymentIntent(paymentIntentId);
  if (!grant) {
    logger.info(
      `[Stripe Queue] ${source} ${reference}: no credit grant for PI ${paymentIntentId}; nothing to claw back`,
    );
    return;
  }

  const grantAmountMicros = parseCreditMicros(grant.amount);
  if (!grantAmountMicros || grantAmountMicros <= 0n) {
    logger.warn(
      `[Stripe Queue] ${source} ${reference}: invalid credit grant amount for PI ${paymentIntentId}`,
      { amount: grant.amount },
    );
    return;
  }

  const checkoutOrder =
    await stripeCheckoutOrdersService.getByPaymentIntent(paymentIntentId);
  const autoTopUpCharge = checkoutOrder
    ? null
    : autoTopUpChargeBreakdownFromMetadata(grant.metadata);
  const autoTopUpChargeMicros = autoTopUpCharge
    ? parseCreditMicros(autoTopUpCharge.totalChargeUsd)
    : null;
  const chargeAmountCents =
    checkoutOrder?.charge_amount_cents ??
    (autoTopUpChargeMicros ? autoTopUpChargeMicros / 10_000n : null);
  const reversedCents = BigInt(Math.round(usdReversed * 100));
  const reversedMicros = reversedCents * 10_000n;
  const targetMicros =
    chargeAmountCents && chargeAmountCents > 0n
      ? minBigInt(
          grantAmountMicros,
          roundedDivide(
            grantAmountMicros * minBigInt(reversedCents, chargeAmountCents),
            chargeAmountCents,
          ),
        )
      : minBigInt(reversedMicros, grantAmountMicros);
  const cappedUsdReversed = Number(targetMicros) / 1_000_000;
  const result = await creditsService.clawbackCredits({
    organizationId: grant.organization_id,
    amount: cappedUsdReversed,
    cumulativeTargetAmount: cappedUsdReversed,
    originalPaymentIntentId: paymentIntentId,
    description: `Stripe ${source} clawback — ${reference}`,
    stripePaymentIntentId: idempotencyKey,
    metadata: {
      payment_intent_id: paymentIntentId,
      reversed_usd: usdReversed,
      capped_reversed_usd: cappedUsdReversed,
      ...(checkoutOrder
        ? {
            checkout_order_id: checkoutOrder.id,
            original_charge_usd: (Number(chargeAmountCents) / 100).toFixed(2),
            original_credits_granted: formatCreditMicros(grantAmountMicros),
          }
        : autoTopUpCharge
          ? {
              auto_top_up_attempt_id: grant.metadata.auto_top_up_attempt_id,
              original_charge_usd: autoTopUpCharge.totalChargeUsd,
              original_credits_granted: formatCreditMicros(grantAmountMicros),
            }
          : {}),
      source,
      reference,
    },
  });

  if (result.alreadyProcessed) {
    logger.info(
      `[Stripe Queue] ${source} ${reference}: cumulative target $${cappedUsdReversed.toFixed(6)} already processed`,
    );
    return;
  }

  logger.warn(
    `[Stripe Queue] Clawed back $${result.appliedAmount.toFixed(2)} from org ${grant.organization_id} for ${source} ${reference} (new balance $${result.newBalance.toFixed(2)})`,
    {
      cumulativeTargetUsd: cappedUsdReversed,
      unrecoveredUsd: result.shortfallAmount,
    },
  );
}

async function handleChargeRefunded(event: Stripe.Event): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  // `amount_refunded` is the CUMULATIVE refunded amount (cents) on the charge.
  await clawbackForReversal({
    paymentIntentId: chargePaymentIntentId(charge),
    usdReversed: (charge.amount_refunded ?? 0) / 100,
    // Key on the cumulative amount so each new partial-refund total is a distinct
    // idempotent clawback, while a re-delivery of the same state is a no-op.
    idempotencyKey: `stripe:refund:${charge.id}:${charge.amount_refunded}`,
    source: "charge.refunded",
    reference: `charge ${charge.id}`,
  });
}

async function handleChargeDisputeFundsWithdrawn(
  event: Stripe.Event,
): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeId =
    typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  const paymentIntentId =
    typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : dispute.payment_intent?.id;
  // Stripe withdraws funds when the dispute opens. If the platform wins, the
  // separate `funds_reinstated` event below compensates the applied clawback.
  await clawbackForReversal({
    paymentIntentId,
    usdReversed: (dispute.amount ?? 0) / 100,
    idempotencyKey: `stripe:dispute:${dispute.id}`,
    source: "charge.dispute.funds_withdrawn",
    reference: `dispute ${dispute.id}${chargeId ? ` (charge ${chargeId})` : ""}`,
  });
}

/**
 * A dispute that closes LOST makes its `funds_withdrawn` clawback final. The
 * clawback already recorded any unrecovered shortfall together with its
 * billing hold, which now clears only through repayment (#22930 Decision A).
 * An organization whose clawback fully recovered the reversal owes nothing and
 * is not held. Nothing here mutates credits or holds.
 */
async function handleChargeDisputeClosed(event: Stripe.Event): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  if (dispute.status !== "lost") return;
  const clawback = await creditsService.getTransactionByStripePaymentIntent(
    `stripe:dispute:${dispute.id}`,
  );
  logger.info(
    `[Stripe Queue] charge.dispute.closed dispute ${dispute.id}: lost; withdrawal clawback is final`,
    {
      organizationId: clawback?.organization_id,
      unrecoveredUsd: clawback?.metadata?.unrecovered_clawback_usd ?? null,
    },
  );
}

async function handleChargeDisputeFundsReinstated(
  event: Stripe.Event,
): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeId =
    typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  const paymentIntentId =
    typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : dispute.payment_intent?.id;
  const source = "charge.dispute.funds_reinstated";
  const reference = `dispute ${dispute.id}${chargeId ? ` (charge ${chargeId})` : ""}`;
  const clawbackKey = `stripe:dispute:${dispute.id}`;

  const clawback =
    await creditsService.getTransactionByStripePaymentIntent(clawbackKey);
  if (clawback?.type !== "clawback") {
    // Stripe does not guarantee event ordering. Retry until the corresponding
    // funds-withdrawn mutation commits (or the message reaches reconciliation)
    // instead of acknowledging and permanently dropping a valid reinstatement.
    throw new Error(
      `Dispute clawback is not yet available for reinstatement ${reference}`,
    );
  }

  // Stripe returned the disputed funds, so the unrecovered shortfall is no
  // longer owed: clear the hold this clawback placed first (#22930). Its
  // outstanding amount is frozen at release, which keeps the repayment
  // returned below stable across redeliveries.
  const { releaseShortfallHoldForReinstatement } = await import(
    "@elizaos/cloud-shared/db/repositories/payment-reversal-holds"
  );
  const hold = await releaseShortfallHoldForReinstatement({
    clawbackTransactionId: clawback.id,
    stripeDisputeId: dispute.id,
  });
  const shortfallMicros = hold
    ? parseCreditMicros(hold.shortfall_usd ?? "")
    : 0n;
  const outstandingMicros = hold
    ? parseCreditMicros(hold.outstanding_usd ?? "")
    : 0n;
  if (shortfallMicros === null || outstandingMicros === null) {
    throw new Error(
      `Invalid shortfall hold amounts for reinstatement ${reference}`,
    );
  }
  const repaidMicros = shortfallMicros - outstandingMicros;

  // Return any repayment the organization already made toward that shortfall
  // as its own ledger entry. It is deliberately not tagged with the payment
  // intent, so the cumulative reversal tally for later refunds nets only the
  // clawback reinstatement below.
  if (repaidMicros > 0n) {
    const repaidUsd = formatCreditMicros(repaidMicros);
    await creditsService.refundCredits({
      organizationId: clawback.organization_id,
      amount: repaidUsd,
      description: `Stripe ${source} return of shortfall repayment — ${reference}`,
      stripePaymentIntentId: `${clawbackKey}:repayment-returned`,
      metadata: {
        type: "reversal_shortfall_repayment_return",
        hold_id: hold?.id,
        clawback_key: clawbackKey,
        reference,
      },
    });
  }

  // `clawback.amount` is the credit amount actually removed by the matching
  // funds-withdrawn event (already scaled from the disputed provider amount to
  // the pack's credit units and capped at the balance then available). Winning
  // the dispute restores exactly that — never provider dollars, which differ
  // from credit units for packs, and never the unrecovered shortfall. (#31449)
  const reinstatedUsd = Math.abs(Number(clawback.amount));
  if (!Number.isFinite(reinstatedUsd) || reinstatedUsd <= 0) {
    logger.info(
      `[Stripe Queue] ${source} ${reference}: no applied clawback amount to reinstate`,
      { clawbackAmount: clawback.amount, disputeAmount: dispute.amount },
    );
    await settleShortfallsAfterCredit(clawback.organization_id, source);
    return;
  }

  const result = await creditsService.refundCredits({
    organizationId: clawback.organization_id,
    amount: reinstatedUsd,
    description: `Stripe ${source} reinstatement — ${reference}`,
    stripePaymentIntentId: `${clawbackKey}:reinstated`,
    metadata: {
      payment_intent_id: paymentIntentId,
      disputed_usd: (dispute.amount ?? 0) / 100,
      applied_reinstatement_usd: reinstatedUsd,
      clawback_key: clawbackKey,
      source,
      reference,
    },
  });

  logger.info(
    `[Stripe Queue] Reinstated $${reinstatedUsd.toFixed(2)} to org ${clawback.organization_id} for ${source} ${reference} (new balance $${result.newBalance.toFixed(2)})`,
  );
  await settleShortfallsAfterCredit(clawback.organization_id, source);
}

/**
 * Credits that land while reversal shortfalls are outstanding repay them
 * first (#22930). Runs after the credit commits; if it fails the hold simply
 * stays in force and the queue retries the idempotent delivery. Returns
 * whether a hold is still active afterwards.
 */
async function settleShortfallsAfterCredit(
  organizationId: string,
  source: string,
): Promise<boolean> {
  const { billingHoldService } = await import(
    "@elizaos/cloud-shared/lib/services/billing-hold"
  );
  const settlement =
    await billingHoldService.settleOutstandingShortfalls(organizationId);
  if (settlement.appliedUsd !== "0.000000") {
    logger.info(
      `[Stripe Queue] ${source}: applied $${settlement.appliedUsd} to reversal shortfalls for org ${organizationId}`,
      {
        outstandingUsd: settlement.outstandingUsd,
        releasedHolds: settlement.releasedHoldIds.length,
      },
    );
  }
  return (await billingHoldService.getState(organizationId)).status === "held";
}
