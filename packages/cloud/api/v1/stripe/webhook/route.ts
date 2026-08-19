/**
 * POST /api/v1/stripe/webhook
 *
 * Unauthed but signature-verified Stripe webhook for the unified
 * payment_requests flow. Verifies the signature via the Stripe
 * adapter, atomically persists the provider event, request transition, and
 * organization-credit grant, then dispatches the non-authoritative callback.
 *
 * Distinct from the legacy `/api/stripe/webhook` route, which feeds
 * the app-credit / org-credit settlement queue.
 */

import { Hono } from "hono";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { stripePaymentAdapter } from "@/lib/services/payment-adapters/stripe";
import { paymentCallbackBus } from "@/lib/services/payment-callback-bus";
import {
  dispatchPaymentCallbacks,
  processPaymentProviderEvent,
  sha256Hex,
} from "@/lib/services/payment-request-settlement";
import { IgnoredWebhookEvent } from "@/lib/services/payment-webhook-errors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.AGGRESSIVE), async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("stripe-signature") ?? null;

  if (!signature) {
    return c.json(
      { success: false, error: "Missing stripe-signature header" },
      400,
    );
  }

  if (!stripePaymentAdapter.parseWebhook) {
    return c.json(
      { success: false, error: "Stripe adapter does not support webhooks" },
      500,
    );
  }

  let parsed: Awaited<
    ReturnType<NonNullable<typeof stripePaymentAdapter.parseWebhook>>
  >;
  try {
    parsed = await stripePaymentAdapter.parseWebhook({ rawBody, signature });
  } catch (error) {
    // error-policy:J1 translate provider authentication and parsing failures.
    if (error instanceof IgnoredWebhookEvent) {
      logger.info("[StripeWebhook API] Ignored event", {
        reason: error.message,
      });
      return c.json({ success: true, ignored: true }, 200);
    }
    logger.warn("[StripeWebhook API] Signature verification or parse failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      { success: false, error: "Webhook verification failed" },
      400,
    );
  }

  if (!parsed.txRef) {
    return c.json(
      { success: false, error: "Webhook transaction reference missing" },
      400,
    );
  }

  const failureReason =
    parsed.status === "failed" &&
    typeof parsed.proof.stripe_failure_message === "string"
      ? parsed.proof.stripe_failure_message
      : "Stripe payment failed";
  let processed: Awaited<ReturnType<typeof processPaymentProviderEvent>>;
  try {
    processed = await processPaymentProviderEvent({
      provider: "stripe",
      providerEventId: parsed.providerEventId,
      paymentRequestId: parsed.paymentRequestId,
      disposition: parsed.status,
      providerTxRef: parsed.txRef,
      payloadDigest: await sha256Hex(rawBody),
      amountCents: parsed.amountCents,
      currency: parsed.currency,
      proof: parsed.proof,
      error: failureReason,
    });
  } catch (error) {
    // error-policy:J1 provider retries on durable settlement failure.
    logger.error("[StripeWebhook API] Durable fulfillment failed", {
      paymentRequestId: parsed.paymentRequestId,
      providerEventId: parsed.providerEventId,
      error,
    });
    return c.json({ success: false, error: "Webhook fulfillment failed" }, 500);
  }

  if (
    processed.callbackState === "pending" ||
    processed.callbackState === "failed"
  ) {
    await paymentCallbackBus.publish(processed.callback);
    await dispatchPaymentCallbacks({
      provider: "stripe",
      providerEventId: processed.callback.providerEventId,
      limit: 1,
    });
  }

  return c.json({ success: true, duplicate: processed.replay }, 200);
});

export default app;
