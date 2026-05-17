import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { users } from "./users";

/**
 * App earnings table schema.
 *
 * Tracks earnings for third-party apps from inference markup and purchase shares.
 */
export const appEarnings = pgTable(
  "app_earnings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    total_lifetime_earnings: numeric("total_lifetime_earnings", {
      precision: 12,
      scale: 6,
    })
      .notNull()
      .default("0.000000"),
    total_inference_earnings: numeric("total_inference_earnings", {
      precision: 12,
      scale: 6,
    })
      .notNull()
      .default("0.000000"),
    total_purchase_earnings: numeric("total_purchase_earnings", {
      precision: 12,
      scale: 6,
    })
      .notNull()
      .default("0.000000"),
    pending_balance: numeric("pending_balance", { precision: 12, scale: 6 })
      .notNull()
      .default("0.000000"),
    withdrawable_balance: numeric("withdrawable_balance", {
      precision: 12,
      scale: 6,
    })
      .notNull()
      .default("0.000000"),
    total_withdrawn: numeric("total_withdrawn", { precision: 12, scale: 6 })
      .notNull()
      .default("0.000000"),
    last_withdrawal_at: timestamp("last_withdrawal_at"),
    payout_threshold: numeric("payout_threshold", { precision: 10, scale: 2 })
      .notNull()
      .default("25.00"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    app_unique: uniqueIndex("app_earnings_app_idx").on(table.app_id),
  }),
);

/**
 * App earnings transactions table schema.
 *
 * Records individual earnings transactions including inference markup, purchase shares, and withdrawals.
 */
export const appEarningsTransactions = pgTable(
  "app_earnings_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    amount: numeric("amount", { precision: 10, scale: 6 }).notNull(),
    description: text("description"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    app_idx: index("app_earnings_transactions_app_idx").on(table.app_id),
    app_created_idx: index("app_earnings_transactions_app_created_idx").on(
      table.app_id,
      table.created_at,
    ),
    user_idx: index("app_earnings_transactions_user_idx").on(table.user_id),
    type_idx: index("app_earnings_transactions_type_idx").on(table.type),
  }),
);

export type AppEarnings = InferSelectModel<typeof appEarnings>;
export type NewAppEarnings = InferInsertModel<typeof appEarnings>;
export type AppEarningsTransaction = InferSelectModel<typeof appEarningsTransactions>;
export type NewAppEarningsTransaction = InferInsertModel<typeof appEarningsTransactions>;
