import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
  },
  (table) => ({
    provider_idx: index("webhook_events_provider_idx").on(table.provider),
    processed_at_idx: index("webhook_events_processed_at_idx").on(table.processed_at),
    // Composite index for cleanup queries
    provider_processed_idx: index("webhook_events_provider_processed_idx").on(
      table.provider,
      table.processed_at,
    ),
  }),
);

export type WebhookEvent = InferSelectModel<typeof webhookEvents>;
export type NewWebhookEvent = InferInsertModel<typeof webhookEvents>;
