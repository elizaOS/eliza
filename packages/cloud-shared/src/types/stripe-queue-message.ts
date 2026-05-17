/**
 * Stripe queue payloads for the Redis-backed webhook fan-out queue.
 */

import type Stripe from "stripe";

/**
 * Verified Stripe event handed off from the webhook route to the consumer.
 */
export type StripeEventMessage = {
  kind: "stripe.event";
  eventId: string;
  eventType: string;
  /** Full verified Stripe.Event payload — same shape Stripe sends. */
  event: Stripe.Event;
  /** Best-effort extracted from the event for dedup; may be absent. */
  paymentIntentId?: string;
  /** Worker receive timestamp (ms epoch). */
  receivedAt: number;
};
