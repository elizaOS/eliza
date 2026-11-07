/** Persists verified webhook deduplication and recoverable app billing lookup triggers. */

import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AppBillingWebhookTrigger } from "../../types/app-billing-webhook";
import type { StripeEventMessage } from "../../types/stripe-queue-message";

/** `event_id` is unique — Postgres already indexes it; no separate btree on event_id. */

/**
 * Webhook events table schema.
 *
 * Tracks processed webhook events to prevent replay attacks.
 * Each webhook event is stored with its unique ID and timestamp
 * to enable deduplication and timestamp validation.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Unique identifier from the webhook provider (e.g., OxaPay track_id + timestamp hash)
    event_id: text("event_id").notNull().unique(),
    app_billing_trigger: jsonb("app_billing_trigger").$type<AppBillingWebhookTrigger>(),
    app_billing_completed_at: timestamp("app_billing_completed_at", { withTimezone: true }),
    app_billing_next_attempt_at: timestamp("app_billing_next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    app_billing_error_code: text("app_billing_error_code"),
    // The webhook provider (e.g., "oxapay", "stripe")
    provider: text("provider").notNull(),
    // The event type/status from the webhook
    event_type: text("event_type"),
    // Hash of the payload for additional verification
    payload_hash: text("payload_hash").notNull(),
    // IP address of the webhook sender
    source_ip: text("source_ip"),
    // When the webhook was processed
    processed_at: timestamp("processed_at").notNull().defaultNow(),
    // Optional: timestamp from the webhook payload itself
    event_timestamp: timestamp("event_timestamp"),
    // Stripe delivery outbox: the work for this verified event, written in the dedupe insert.
    delivery_payload: jsonb("delivery_payload").$type<StripeEventMessage>(),
    delivery_attempts: integer("delivery_attempts").notNull().default(0),
    delivery_next_attempt_at: timestamp("delivery_next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    delivery_lease_token: uuid("delivery_lease_token"),
    delivery_lease_expires_at: timestamp("delivery_lease_expires_at", { withTimezone: true }),
    delivery_completed_at: timestamp("delivery_completed_at", { withTimezone: true }),
    delivery_dead_lettered_at: timestamp("delivery_dead_lettered_at", { withTimezone: true }),
  },
  (table) => ({
    app_billing_due_idx: index("webhook_events_app_billing_due_idx")
      .on(table.app_billing_next_attempt_at)
      .where(
        sql`${table.app_billing_trigger} IS NOT NULL AND ${table.app_billing_completed_at} IS NULL`,
      ),
    delivery_due_idx: index("webhook_events_delivery_due_idx")
      .on(table.delivery_next_attempt_at)
      .where(
        sql`${table.delivery_payload} IS NOT NULL AND ${table.delivery_completed_at} IS NULL AND ${table.delivery_dead_lettered_at} IS NULL`,
      ),
    delivery_lease_check: check(
      "webhook_events_delivery_lease_check",
      sql`(${table.delivery_lease_token} IS NULL) = (${table.delivery_lease_expires_at} IS NULL)`,
    ),
    provider_idx: index("webhook_events_provider_idx").on(table.provider),
    processed_at_idx: index("webhook_events_processed_at_idx").on(table.processed_at),
    // Composite index for webhook retention queries
    provider_processed_idx: index("webhook_events_provider_processed_idx").on(
      table.provider,
      table.processed_at,
    ),
  }),
);

export type WebhookEvent = InferSelectModel<typeof webhookEvents>;
export type NewWebhookEvent = InferInsertModel<typeof webhookEvents>;
