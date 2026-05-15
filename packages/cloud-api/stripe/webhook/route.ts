import { Hono } from "hono";
import type Stripe from "stripe";
import type { StripeEventMessage } from "@/api-queue/types";
import { webhookEventsRepository } from "@/db/repositories/webhook-events";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { enqueue } from "@/lib/queue/redis-queue";
import { isStripeConfigured, requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const STRIPE_QUEUE_KEY = "stripe-events";

/**
 * Best-effort extraction of the Stripe payment_intent ID from any event we
 * care about. The consumer uses this for per-row idempotency checks; the
 * primary dedup is the webhook_events table on event.id (Stripe evt_*).
 */
function extractPaymentIntentId(event: Stripe.Event): string | undefined {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      return typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;
    }
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed": {
      const pi = event.data.object as Stripe.PaymentIntent;
      return pi.id;
    }
    default:
      return undefined;
  }
}

/**
 * Quick SHA-256 of the body for the webhook_events.payload_hash column.
 * WebCrypto-only so this works on Workers.
 */
async function hashPayload(body: string): Promise<string> {
  const data = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getClientIp(c: AppContext): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown"
  );
}

/**
 * POST /api/stripe/webhook
 *
 * Cloudflare Workers entry point — verifies the Stripe signature, dedupes
 * by Stripe event ID via webhook_events, then enqueues to Redis and returns
 * 200 immediately. The heavy fan-out (app credits, org credits, revenue
 * splits, redeemable earnings, cache invalidation, Discord notifications,
 * invoice rows) runs from /api/cron/process-stripe-queue.
 *
 * Idempotency:
 *   1. webhook_events.tryCreate(event_id) catches Stripe's at-least-once
 *      retries before enqueueing — duplicate webhooks return 200 without
 *      sending a queue message.
 *   2. The consumer additionally checks each downstream write
 *      (creditsService.getTransactionByStripePaymentIntent, redeemable
 *      earnings dedupeBySourceId) so a queue retry after a partial
 *      failure cannot double-credit either.
 *
 * Rate limited: AGGRESSIVE (100 req/min per IP).
 */
async function handleStripeWebhook(c: AppContext): Promise<Response> {
  const body = await c.req.text();
  const signature = c.req.header("stripe-signature");

  if (!signature) {
    return c.json({ error: "No signature provided" }, 400);
  }

  const webhookSecret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error("[Stripe Webhook] STRIPE_WEBHOOK_SECRET is not set");
    return c.json({ error: "Webhook configuration error" }, 500);
  }

  if (!isStripeConfigured()) {
    logger.error("[Stripe Webhook] STRIPE_SECRET_KEY is not set");
    return c.json({ error: "Stripe configuration error" }, 500);
  }

  const stripe = requireStripe();
  let event: Stripe.Event;

  try {
    // constructEventAsync uses WebCrypto and works on Workers; the sync
    // variant calls into node:crypto which is not available here.
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch {
    logger.error("[Stripe Webhook] Signature verification failed");
    return c.json({ error: "Webhook signature verification failed" }, 400);
  }

  logger.info(`[Stripe Webhook] Received event: ${event.type} (${event.id})`);

  const payloadHash = await hashPayload(body);
  const insertResult = await webhookEventsRepository.tryCreate({
    event_id: event.id,
    provider: "stripe",
    event_type: event.type,
    payload_hash: payloadHash,
    source_ip: getClientIp(c),
    event_timestamp: event.created ? new Date(event.created * 1000) : undefined,
  });

  if (!insertResult.created) {
    logger.debug(`[Stripe Webhook] Duplicate event ${event.id} — skipping enqueue`);
    return c.json({ received: true, duplicate: true }, 200);
  }

  const message: StripeEventMessage = {
    kind: "stripe.event",
    eventId: event.id,
    eventType: event.type,
    event,
    paymentIntentId: extractPaymentIntentId(event),
    receivedAt: Date.now(),
  };

  await enqueue(STRIPE_QUEUE_KEY, message);

  return c.json({ received: true, queued: true }, 200);
}

const app = new Hono<AppEnv>();
app.post("/", rateLimit(RateLimitPresets.AGGRESSIVE), (c) => handleStripeWebhook(c));
export default app;
