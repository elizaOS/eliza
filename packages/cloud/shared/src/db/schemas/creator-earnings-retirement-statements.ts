/**
 * Frozen creator-earnings statements (#22961 / #23022).
 *
 * Creator monetization is retired. Migration 0500 recorded every user's unpaid
 * redeemable balance (available + pending) at retirement time. Rows are
 * read-only for customers; an operator marks a row `settled_manually` with a
 * reference once the balance has been handled out of band. No code path pays
 * a frozen balance automatically.
 *
 * The table has no foreign keys on purpose: the liability record must survive
 * account deletion.
 */

import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const creatorEarningsRetirementStatements = pgTable(
  "creator_earnings_retirement_statements",
  {
    user_id: uuid("user_id").primaryKey(),
    organization_id: uuid("organization_id"),
    status: text("status", { enum: ["frozen", "settled_manually"] })
      .notNull()
      .default("frozen"),
    total_earned_usd: numeric("total_earned_usd", { precision: 18, scale: 4 }).notNull(),
    total_redeemed_usd: numeric("total_redeemed_usd", { precision: 18, scale: 4 }).notNull(),
    total_converted_to_credits_usd: numeric("total_converted_to_credits_usd", {
      precision: 18,
      scale: 4,
    }).notNull(),
    available_balance_usd: numeric("available_balance_usd", { precision: 18, scale: 4 }).notNull(),
    pending_redemption_usd: numeric("pending_redemption_usd", {
      precision: 18,
      scale: 4,
    }).notNull(),
    unpaid_balance_usd: numeric("unpaid_balance_usd", { precision: 18, scale: 4 }).notNull(),
    earned_from_apps_usd: numeric("earned_from_apps_usd", { precision: 18, scale: 4 }).notNull(),
    earned_from_agents_usd: numeric("earned_from_agents_usd", {
      precision: 18,
      scale: 4,
    }).notNull(),
    earned_from_mcps_usd: numeric("earned_from_mcps_usd", { precision: 18, scale: 4 }).notNull(),
    earned_from_affiliates_usd: numeric("earned_from_affiliates_usd", {
      precision: 18,
      scale: 4,
    }).notNull(),
    earned_from_revenue_shares_usd: numeric("earned_from_revenue_shares_usd", {
      precision: 18,
      scale: 4,
    }).notNull(),
    frozen_at: timestamp("frozen_at", { withTimezone: true }).notNull().defaultNow(),
    settled_at: timestamp("settled_at", { withTimezone: true }),
    settlement_reference: text("settlement_reference"),
  },
  (table) => ({
    organization_idx: index("creator_earnings_retirement_statements_org_idx").on(
      table.organization_id,
    ),
    frozen_idx: index("creator_earnings_retirement_statements_frozen_idx")
      .on(table.status)
      .where(sql`${table.status} = 'frozen'`),
    status_check: check(
      "creator_earnings_retirement_statements_status_check",
      sql`(${table.status} = 'frozen' AND ${table.settled_at} IS NULL AND ${table.settlement_reference} IS NULL)
        OR (${table.status} = 'settled_manually' AND ${table.settled_at} IS NOT NULL AND ${table.settlement_reference} IS NOT NULL)`,
    ),
    amounts_check: check(
      "creator_earnings_retirement_statements_amounts_check",
      sql`${table.available_balance_usd} >= 0 AND ${table.pending_redemption_usd} >= 0
        AND ${table.unpaid_balance_usd} = ${table.available_balance_usd} + ${table.pending_redemption_usd}
        AND ${table.unpaid_balance_usd} > 0`,
    ),
  }),
);

export type CreatorEarningsRetirementStatement = InferSelectModel<
  typeof creatorEarningsRetirementStatements
>;

/**
 * Singleton recording when creator monetization was retired (migration 0500).
 * Affiliate earnings credited after `retired_at` are payable through the
 * affiliate-only payout path; balances before it are frozen.
 */
export const creatorMonetizationRetirement = pgTable(
  "creator_monetization_retirement",
  {
    id: boolean("id").primaryKey().default(true),
    retired_at: timestamp("retired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singleton_check: check("creator_monetization_retirement_singleton_check", sql`${table.id}`),
  }),
);
