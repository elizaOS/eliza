/**
 * Stripe delivery payloads, stored in the webhook_events outbox row.
 */

import type Stripe from "stripe";
import type { AppBillingWebhookTrigger } from "./app-billing-webhook";

/**
 * Verified Stripe event the webhook route records for the consumer.
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
  appBilling?: { receiptKey: string; trigger: AppBillingWebhookTrigger };
};
