/**
 * Durable affiliate payout intents created in the same transaction that
 * settles a consumer credit reservation. The source id is the global money
 * identity; processors may retry until the redeemable ledger acknowledges it.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const affiliatePayoutOutbox = pgTable(
  "affiliate_payout_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source_id: text("source_id").notNull(),
    // The charge-time code identity is an audit snapshot. A later code delete
    // must not redirect or roll back an already-collected payout.
    affiliate_code_id: uuid("affiliate_code_id").notNull(),
    affiliate_user_id: uuid("affiliate_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    description: text("description").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    attempts: integer("attempts").notNull().default(0),
    next_attempt_at: timestamp("next_attempt_at").notNull().defaultNow(),
    processed_at: timestamp("processed_at"),
    ledger_entry_id: uuid("ledger_entry_id"),
    last_error: text("last_error"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    source_unique: uniqueIndex("affiliate_payout_outbox_source_uidx").on(table.source_id),
    pending_due_idx: index("affiliate_payout_outbox_pending_due_idx")
      .on(table.next_attempt_at, table.created_at)
      .where(sql`${table.processed_at} IS NULL`),
    source_canonical: check(
      "affiliate_payout_outbox_source_canonical",
      sql`${table.source_id} <> ''
        AND ${table.source_id} !~ '^[[:space:]]'
        AND ${table.source_id} !~ '[[:space:]]$'`,
    ),
    amount_positive: check("affiliate_payout_outbox_amount_positive", sql`${table.amount} > 0`),
  }),
);

export type AffiliatePayoutOutboxRow = InferSelectModel<typeof affiliatePayoutOutbox>;
export type NewAffiliatePayoutOutboxRow = InferInsertModel<typeof affiliatePayoutOutbox>;
