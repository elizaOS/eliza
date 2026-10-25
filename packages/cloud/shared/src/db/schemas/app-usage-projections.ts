/**
 * Exactly-once projections of durable app debit events into mutable usage
 * counters. The debit transaction is the source of truth; this row is the
 * transactional claim that prevents retries from incrementing counters twice.
 */

import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { check, index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { creditTransactions } from "./credit-transactions";

export type AppUsageProjectionStatus =
  | "pending"
  | "applied"
  | "skipped_missing_app"
  | "skipped_missing_user";

export const appUsageProjections = pgTable(
  "app_usage_projections",
  {
    charge_transaction_id: uuid("charge_transaction_id")
      .primaryKey()
      .references(() => creditTransactions.id, { onDelete: "cascade" }),
    // App/user identities intentionally survive their source rows. Recovery can
    // then record a terminal skip after either FK target was deleted.
    app_id: uuid("app_id").notNull(),
    user_id: uuid("user_id").notNull(),
    credits_used: numeric("credits_used", { precision: 12, scale: 6 }).notNull(),
    status: text("status").$type<AppUsageProjectionStatus>().notNull().default("pending"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    projected_at: timestamp("projected_at"),
  },
  (table) => ({
    app_created_idx: index("app_usage_projections_app_created_idx").on(
      table.app_id,
      table.created_at,
    ),
    status_created_idx: index("app_usage_projections_status_created_idx").on(
      table.status,
      table.created_at,
    ),
    status_valid: check(
      "app_usage_projections_status_valid",
      sql`${table.status} IN (
        'pending',
        'applied',
        'skipped_missing_app',
        'skipped_missing_user'
      )`,
    ),
    credits_nonnegative: check(
      "app_usage_projections_credits_nonnegative",
      sql`${table.credits_used} >= 0`,
    ),
  }),
);

export type AppUsageProjection = InferSelectModel<typeof appUsageProjections>;
export type NewAppUsageProjection = InferInsertModel<typeof appUsageProjections>;
