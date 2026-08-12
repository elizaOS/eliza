/**
 * POST /api/v1/stripe/webhook
 *
 * Unauthed but signature-verified Stripe webhook for the unified
 * payment_requests flow. Verifies the signature via the Stripe
 * adapter, dedupes by Stripe event id, persists the payment request
 * transition, then publishes a `PaymentSettled` / `PaymentFailed`
 * event to the in-process payment callback bus.
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
import { getPaymentRequestsService } from "@/lib/services/payment-requests-default";
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

  const providerEventId =
    typeof parsed.proof.stripe_event_id === "string"
      ? parsed.proof.stripe_event_id
      : null;
  const service = getPaymentRequestsService(c.env);
  const failureReason =
    parsed.status === "settled"
      ? null
      : typeof parsed.proof.stripe_failure_message === "string"
        ? parsed.proof.stripe_failure_message
        : "Stripe payment failed";

  // Persist before recording the in-process publish key. Otherwise a transient
  // or deadline rejection poisons Stripe's retry and can silently drop money.
  try {
    if (parsed.status === "settled") {
      await service.markSettled(
        parsed.paymentRequestId,
        parsed.txRef ?? providerEventId ?? "stripe:settled",
        parsed.proof,
      );
    } else {
      await service.markFailed(
        parsed.paymentRequestId,
        failureReason ?? "Stripe payment failed",
      );
    }
  } catch (error) {
    // error-policy:J1 a rejected transition is never published or acknowledged.
    logger.error("[StripeWebhook API] Settlement persistence failed", {
      paymentRequestId: parsed.paymentRequestId,
      status: parsed.status,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      { success: false, error: "Settlement persistence failed" },
      500,
    );
  }

  if (providerEventId) {
    const recorded = paymentCallbackBus.recordProviderEvent(
      "stripe",
      providerEventId,
    );
    if (!recorded) {
      logger.debug("[StripeWebhook API] Duplicate event — skipping publish", {
        providerEventId,
      });
      return c.json({ success: true, duplicate: true }, 200);
    }
  }

  if (parsed.status === "settled") {
    await paymentCallbackBus.publish({
      name: "PaymentSettled",
      paymentRequestId: parsed.paymentRequestId,
      provider: "stripe",
      txRef: parsed.txRef,
      providerEventId: providerEventId ?? undefined,
      settledAt: new Date(),
    });
  } else {
    await paymentCallbackBus.publish({
      name: "PaymentFailed",
      paymentRequestId: parsed.paymentRequestId,
      provider: "stripe",
      txRef: parsed.txRef,
      providerEventId: providerEventId ?? undefined,
      error: failureReason ?? "Stripe payment failed",
      failedAt: new Date(),
    });
  }

  return c.json({ success: true, published: true }, 200);
});

export default app;
