/**
 * Redis queue consumer for Stripe events.
 *
 * Runs the heavy fan-out that used to live inline in /api/stripe/webhook
 * before the queue refactor — app credits, org credits, revenue splits,
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
 * Failure handling:
 *   - Permanent failures (bad metadata, missing required fields) ack the
 *     message — there is no recovery path and we do not want them eating
 *     retry budget.
 *   - Transient failures (DB error, downstream timeout, etc.) return
 *     `retry`. After the retry budget is exhausted, the Redis queue helper
 *     promotes the message to stripe-events:dlq for manual reconciliation.
 */

import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";

import { dbRead } from "@/db/helpers";
import { organizationsRepository } from "@/db/repositories/organizations";
import { usersRepository } from "@/db/repositories/users";
import { agentSandboxes } from "@/db/schemas/agent-sandboxes";
import type { DrainResult } from "@/lib/queue/redis-queue";
import { safeFetch } from "@/lib/security/safe-fetch";
import { appChargeCallbacksService } from "@/lib/services/app-charge-callbacks";
import { appChargeSettlementService } from "@/lib/services/app-charge-settlement";
import { appCreditsService } from "@/lib/services/app-credits";
import { creditsService } from "@/lib/services/credits";
import { discordService } from "@/lib/services/discord";
import { invoicesService } from "@/lib/services/invoices";
import { invalidateOrgTierCache } from "@/lib/services/org-rate-limits";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { redeemableEarningsService } from "@/lib/services/redeemable-earnings";
import { referralsService } from "@/lib/services/referrals";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";

import type { StripeEventMessage } from "./types";

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
  const { event } = delivery.body;
  logger.info(
    `[Stripe Queue] Processing ${event.type} (${event.id}) attempt=${delivery.attempts}`,
  );

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
  if (session.payment_status !== "paid") return;

  const organizationId = session.metadata?.organization_id;
  const userId = session.metadata?.user_id;
  const creditsStr = session.metadata?.credits || "0";
  const credits = parseAndValidateCredits(creditsStr);
  const paymentIntentId = session.payment_intent as string;
  const purchaseType = session.metadata?.type || "checkout";
  const purchaseSource = session.metadata?.source;
  const appId = session.metadata?.app_id;
  const chargeRequestId = session.metadata?.charge_request_id;
  const agentId = session.metadata?.agent_id;

  const isAppPurchase = purchaseSource === "miniapp_app" && appId && userId;

  if (!organizationId || !credits) {
    logger.warn(
      `[Stripe Queue] Permanent failure - Invalid metadata in checkout session ${session.id}`,
      { hasOrgId: !!organizationId, hasValidCredits: !!credits },
    );
    return;
  }

  if (!paymentIntentId) {
    logger.warn(
      `[Stripe Queue] Permanent failure - No payment intent ID in checkout session ${session.id}`,
    );
    return;
  }

  const existingTransaction =
    await creditsService.getTransactionByStripePaymentIntent(paymentIntentId);
  const isDuplicate = !!existingTransaction;

  if (isDuplicate) {
    logger.debug(
      `[Stripe Queue] Per-row dedup hit - Payment intent ${paymentIntentId} already credited; will still attempt revenue splits (idempotent via dedupeBySourceId)`,
    );
  }

  // App purchases ALWAYS go through processPurchase — NOT gated on the org-credit
  // `isDuplicate`. processPurchase is internally idempotent (its own app-earnings
  // dedup via appEarningsRepository.findTransactionByPaymentIntent + addCredits'
  // ON CONFLICT(stripe_payment_intent_id)), so this is safe on true duplicates
  // AND lets a retry after a PARTIAL failure — org credit committed but creator
  // earnings not yet written — re-enter and record the missing earnings. Gating
  // on the org-credit dedup skipped that re-entry, permanently losing the
  // creator's purchase-share earnings (org-credit and creator-earnings are
  // written non-atomically; the org credit alone flips isDuplicate to true).
  if (isAppPurchase) {
    logger.info(
      `[Stripe Queue] Processing app-specific credit purchase for app ${appId}`,
    );

    const result = await appCreditsService.processPurchase({
      appId,
      userId,
      organizationId,
      purchaseAmount: credits,
      stripePaymentIntentId: paymentIntentId,
    });

    // processPurchase credits the org ledger directly (with this
    // paymentIntentId on the credit transaction), so no separate
    // marker transaction is needed here (#8253).
    logger.info(
      `[Stripe Queue] App credits added: ${result.creditsAdded} to org ${organizationId} for app ${appId} / user ${userId}`,
      {
        creditsAdded: result.creditsAdded,
        platformOffset: result.platformOffset,
        creatorEarnings: result.creatorEarnings,
        newBalance: result.newBalance,
      },
    );

    invalidateOrgTierCache(organizationId).catch((err) =>
      logger.warn("[Stripe Queue] Failed to invalidate org tier cache", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  } else if (!isDuplicate) {
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
  } else if (agentId) {
    await notifyWaifuCreditsToppedUp({
      agentId,
      eventId: `stripe:${event.id}:credits.topped_up:${agentId}:already_applied`,
      credits,
      paymentIntentId,
      sessionId: session.id,
    });
  }

  if (!isAppPurchase && agentId) {
    await enqueueAgentRestartAfterTopUp({
      agentId,
      organizationId,
      userId,
      paymentIntentId,
      sessionId: session.id,
    });
  }

  if (isAppPurchase && appId && userId && chargeRequestId) {
    await appChargeSettlementService.markPaid({
      appId,
      chargeRequestId,
      provider: "stripe",
      providerPaymentId: paymentIntentId,
      amountUsd: credits,
      payerUserId: userId,
      payerOrganizationId: organizationId,
      metadata: {
        stripe_checkout_session_id: session.id,
      },
    });
  }

  // Revenue splits run on every delivery (including duplicate event_id
  // hits at the per-row level) so a retry that previously failed mid-way
  // can complete. dedupeBySourceId guarantees we never insert twice.
  if (!isAppPurchase && userId) {
    const { splits } = await referralsService.calculateRevenueSplits(
      userId,
      credits,
    );
    if (splits.length > 0) {
      logger.info(
        `[Stripe Queue] Processing revenue splits for $${credits.toFixed(2)} purchase by user ${userId}`,
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
            } revenue share (${((split.amount / credits) * 100).toFixed(0)}%) for $${credits.toFixed(2)} purchase`,
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
            amount: credits,
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

  if (!isDuplicate) {
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
      // Invoice row failure is non-critical: credits were already added.
      // Log and continue so we do not retry the whole event for this.
      logger.error(
        "[Stripe Queue] Non-critical error creating invoice record",
        invoiceError,
      );
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

  await provisioningJobService.enqueueAgentRestartOnce({
    agentId: params.agentId,
    organizationId: params.organizationId,
    userId: params.userId,
  });
  void provisioningJobService.triggerImmediate().catch((err) =>
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
// payment_intent.succeeded
// ---------------------------------------------------------------------------

async function handlePaymentIntentSucceeded(
  event: Stripe.Event,
): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  logger.debug(`[Stripe Queue] Payment intent succeeded: ${paymentIntent.id}`);

  // One-time and auto-top-up use PaymentIntent directly (no checkout
  // session). Referral splits run only for checkout.session.completed —
  // affiliate markup is applied when the PaymentIntent is created, so
  // the only payout here is the auto-top-up affiliate fee.
  const purchaseType = paymentIntent.metadata?.type;

  if (!purchaseType || purchaseType === "credit_pack") {
    logger.debug(
      `[Stripe Queue] Skipping payment intent ${paymentIntent.id} - type: ${purchaseType || "unknown"}`,
    );
    return;
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
    (!Number.isFinite(affiliateFeeAmount) || affiliateFeeAmount <= 0)
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

  if (!isDuplicate) {
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

  if (isDuplicate) {
    return;
  }

  // Invoice creation is non-critical — credits were already added above.
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
  }
}

// ---------------------------------------------------------------------------
// payment_intent.payment_failed
// ---------------------------------------------------------------------------

async function handlePaymentIntentFailed(event: Stripe.Event): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const orgId = paymentIntent.metadata?.organization_id;
  const userId = paymentIntent.metadata?.user_id;
  const appId = paymentIntent.metadata?.app_id;
  const chargeRequestId = paymentIntent.metadata?.charge_request_id;
  const purchaseSource = paymentIntent.metadata?.source;
  const amountUsd =
    parseAndValidateCredits(
      paymentIntent.metadata?.credits || paymentIntent.metadata?.amount || "",
    ) ??
    (paymentIntent.amount
      ? Math.round((paymentIntent.amount / 100) * 100) / 100
      : undefined);
  const lastPaymentError = paymentIntent.last_payment_error;
  const errorReason =
    lastPaymentError?.message || lastPaymentError?.code || "Payment failed";

  logger.warn(`[Stripe Queue] Payment intent failed: ${paymentIntent.id}`, {
    paymentIntentId: paymentIntent.id,
    userId,
    organizationId: orgId,
    errorReason,
  });

  if (purchaseSource === "miniapp_app" && appId && chargeRequestId) {
    await appChargeCallbacksService.dispatch({
      appId,
      chargeRequestId,
      status: "failed",
      provider: "stripe",
      providerPaymentId: paymentIntent.id,
      amountUsd,
      payerUserId: userId,
      payerOrganizationId: orgId,
      reason: errorReason,
      metadata: {
        stripe_payment_intent_status: paymentIntent.status,
      },
    });
  }
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
 * Balance top-ups grant credits 1:1 with USD, so `usdReversed` credits are
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
  if (!grant || Number(grant.amount) <= 0) {
    logger.info(
      `[Stripe Queue] ${source} ${reference}: no credit grant for PI ${paymentIntentId}; nothing to claw back`,
    );
    return;
  }

  const grantAmount = Number(grant.amount);
  if (!Number.isFinite(grantAmount) || grantAmount <= 0) {
    logger.warn(
      `[Stripe Queue] ${source} ${reference}: invalid credit grant amount for PI ${paymentIntentId}`,
      { amount: grant.amount },
    );
    return;
  }

  const cappedUsdReversed = Math.min(usdReversed, grantAmount);
  const alreadyClawed =
    await creditsService.getClawedBackUsdForPaymentIntent(paymentIntentId);
  const delta = Math.round((cappedUsdReversed - alreadyClawed) * 1e6) / 1e6;
  if (delta <= 0) {
    logger.info(
      `[Stripe Queue] ${source} ${reference}: $${cappedUsdReversed.toFixed(2)} already clawed back for PI ${paymentIntentId}`,
    );
    return;
  }

  const result = await creditsService.clawbackCredits({
    organizationId: grant.organization_id,
    amount: delta,
    description: `Stripe ${source} clawback — ${reference}`,
    stripePaymentIntentId: idempotencyKey,
    metadata: {
      payment_intent_id: paymentIntentId,
      reversed_usd: usdReversed,
      capped_reversed_usd: cappedUsdReversed,
      source,
      reference,
    },
  });

  if (result.alreadyProcessed) {
    logger.info(
      `[Stripe Queue] ${source} ${reference}: clawback key ${idempotencyKey} already processed`,
    );
    return;
  }

  logger.warn(
    `[Stripe Queue] Clawed back $${result.appliedAmount.toFixed(2)} from org ${grant.organization_id} for ${source} ${reference} (new balance $${result.newBalance.toFixed(2)})`,
    {
      requestedUsd: delta,
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
    logger.info(
      `[Stripe Queue] ${source} ${reference}: no dispute clawback found; nothing to reinstate`,
    );
    return;
  }

  const appliedClawbackUsd = Math.abs(Number(clawback.amount));
  const reinstatedUsd = Math.min(
    (dispute.amount ?? 0) / 100,
    appliedClawbackUsd,
  );
  if (!Number.isFinite(reinstatedUsd) || reinstatedUsd <= 0) {
    logger.info(
      `[Stripe Queue] ${source} ${reference}: no applied clawback amount to reinstate`,
      { clawbackAmount: clawback.amount, disputeAmount: dispute.amount },
    );
    return;
  }

  const result = await creditsService.refundCredits({
    organizationId: clawback.organization_id,
    amount: reinstatedUsd,
    description: `Stripe ${source} reinstatement — ${reference}`,
    stripePaymentIntentId: `${clawbackKey}:reinstated`,
    metadata: {
      payment_intent_id: paymentIntentId,
      reinstated_usd: (dispute.amount ?? 0) / 100,
      applied_reinstatement_usd: reinstatedUsd,
      clawback_key: clawbackKey,
      source,
      reference,
    },
  });

  logger.info(
    `[Stripe Queue] Reinstated $${reinstatedUsd.toFixed(2)} to org ${clawback.organization_id} for ${source} ${reference} (new balance $${result.newBalance.toFixed(2)})`,
  );
}
