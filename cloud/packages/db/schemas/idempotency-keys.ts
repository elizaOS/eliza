/**
 * Idempotency Keys Schema
 *
 * Stores processed webhook message IDs to prevent replay attacks.
 * Supports multi-instance serverless deployments.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull().unique(), // e.g., "blooio:message_123"
    source: text("source").notNull(), // e.g., "blooio", "twilio"
    created_at: timestamp("created_at").notNull().defaultNow(),
    expires_at: timestamp("expires_at").notNull(),
  },
  (table) => ({
    // Note: key already has unique constraint which creates an index
    expires_idx: index("idempotency_keys_expires_idx").on(table.expires_at),
    source_idx: index("idempotency_keys_source_idx").on(table.source),
  }),
);

export type IdempotencyKey = InferSelectModel<typeof idempotencyKeys>;
export type NewIdempotencyKey = InferInsertModel<typeof idempotencyKeys>;
