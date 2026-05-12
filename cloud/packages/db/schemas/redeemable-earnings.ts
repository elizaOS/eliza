/**
 * Redeemable Earnings Schema
 *
 * CRITICAL: This table tracks earnings that can be redeemed for elizaOS tokens.
 *
 * ONLY the following sources are redeemable:
 * 1. App creator earnings (inference markup, purchase shares)
 * 2. Agent creator earnings (from public agents)
 * 3. MCP creator earnings (from published MCPs)
 *
 * SECURITY GUARANTEES:
 * 1. Double-redemption prevention via `total_redeemed` tracking
 * 2. Database CHECK constraint ensures available_balance >= 0
 * 3. Atomic transactions for all balance operations
 * 4. Full audit trail via `redeemable_earnings_ledger`
 * 5. Indexed source IDs support application-level dedupe for retry-safe payouts
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Type of earning source - ONLY these are redeemable
 * Note: "miniapp" is a legacy name in the database, now called "app"
 */
export const earningsSourceEnum = pgEnum("earnings_source", [
  "miniapp", // From owning an app (legacy name, now called "app")
  "agent", // From owning a public agent
  "mcp", // From owning a published MCP
  "affiliate", // From referring users
  "app_owner_revenue_share", // Revenue split for app owners (40%)
  "creator_revenue_share", // Revenue split for creators (10%)
]);

/**
 * Ledger entry types for audit trail
 */
export const ledgerEntryTypeEnum = pgEnum("ledger_entry_type", [
  "earning", // Points earned
  "redemption", // Points redeemed for tokens
  "adjustment", // Admin adjustment
  "refund", // Refund from failed redemption
  "credit_conversion", // Earnings converted into org credit balance (self-fund)
]);

/**
 * Main redeemable earnings balance table
 *
 * One row per user - consolidates all earning sources.
 *
 * CRITICAL CONSTRAINTS:
 * - available_balance = total_earned - total_redeemed - total_pending
 * - available_balance >= 0 (enforced by CHECK constraint)
 */
export const redeemableEarnings = pgTable(
  "redeemable_earnings",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // The user who earned these points
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" })
      .unique(), // One balance per user

    // Total earned from ALL sources (apps + agents + mcps + affiliates)
    // This ONLY increases, never decreases
    total_earned: numeric("total_earned", { precision: 18, scale: 4 }).notNull().default("0.0000"),

    // Total successfully redeemed
    // This ONLY increases, never decreases
    total_redeemed: numeric("total_redeemed", { precision: 18, scale: 4 })
      .notNull()
      .default("0.0000"),

    // Total currently pending redemption (locked)
    // Increases when redemption starts, decreases when completed/refunded
    total_pending: numeric("total_pending", { precision: 18, scale: 4 })
      .notNull()
      .default("0.0000"),

    // Computed available balance (for quick reads)
    // available_balance = total_earned - total_redeemed - total_pending
    available_balance: numeric("available_balance", { precision: 18, scale: 4 })
      .notNull()
      .default("0.0000"),

    // Breakdown by source (for transparency)
    earned_from_miniapps: numeric("earned_from_miniapps", {
      precision: 18,
      scale: 4,
    })
      .notNull()
      .default("0.0000"),
    earned_from_agents: numeric("earned_from_agents", {
      precision: 18,
      scale: 4,
    })
      .notNull()
      .default("0.0000"),
    earned_from_mcps: numeric("earned_from_mcps", { precision: 18, scale: 4 })
      .notNull()
      .default("0.0000"),
    earned_from_affiliates: numeric("earned_from_affiliates", {
      precision: 18,
      scale: 4,
    })
      .notNull()
      .default("0.0000"),
    earned_from_app_owner_shares: numeric("earned_from_app_owner_shares", {
      precision: 18,
      scale: 4,
    })
      .notNull()
      .default("0.0000"),
    earned_from_creator_shares: numeric("earned_from_creator_shares", {
      precision: 18,
      scale: 4,
    })
      .notNull()
      .default("0.0000"),

    // Lifetime amount converted into organization credit balance via the
    // earnings auto-fund flow. Tracked separately from total_redeemed so
    // self-funded hosting does not muddy token-redemption stats.
    total_converted_to_credits: numeric("total_converted_to_credits", {
      precision: 18,
      scale: 4,
    })
      .notNull()
      .default("0.0000"),

    // Last earning/redemption timestamps
    last_earning_at: timestamp("last_earning_at"),
    last_redemption_at: timestamp("last_redemption_at"),

    // Version for optimistic locking (prevents race conditions)
    version: numeric("version", { precision: 10, scale: 0 }).notNull().default("0"),

    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    user_unique: uniqueIndex("redeemable_earnings_user_idx").on(table.user_id),

    // CRITICAL: Ensure available_balance can never go negative
    // This is the primary defense against double-redemption
    available_balance_check: check(
      "available_balance_non_negative",
      sql`${table.available_balance} >= 0`,
    ),

    // Ensure total_earned is always >= total_redeemed + total_pending
    totals_check: check(
      "totals_consistent",
      sql`${table.total_earned} >= ${table.total_redeemed} + ${table.total_pending}`,
    ),
  }),
);

/**
 * Immutable ledger of all earnings and redemptions
 *
 * EVERY change to redeemable_earnings MUST have a corresponding entry here.
 * This provides a complete audit trail and enables reconciliation.
 */
export const redeemableEarningsLedger = pgTable(
  "redeemable_earnings_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Reference to user's earnings balance
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Type of entry
    entry_type: ledgerEntryTypeEnum("entry_type").notNull(),

    // Amount (positive for earnings, negative for redemptions)
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),

    // Balance after this entry (for verification)
    balance_after: numeric("balance_after", {
      precision: 18,
      scale: 4,
    }).notNull(),

    // Source of earning (null for redemptions/adjustments)
    earnings_source: earningsSourceEnum("earnings_source"),

    // Source reference ID (app_id, agent_id, or mcp_id)
    source_id: uuid("source_id"),

    // For redemptions, link to token_redemptions table
    redemption_id: uuid("redemption_id"),

    // Description for audit
    description: text("description").notNull(),

    // Metadata for debugging/auditing
    metadata: jsonb("metadata")
      .$type<{
        transaction_type?: string;
        original_transaction_id?: string;
        admin_user_id?: string;
        ip_address?: string;
        user_agent?: string;
        idempotency_key?: string;
        completed_at?: string;
        network?: string;
        tx_hash?: string;
        refunded_at?: string;
        app_id?: string;
        earnings_type?: string;
        transaction_user_id?: string;
        mcp_id?: string;
        mcp_name?: string;
        tool_name?: string;
        consumer_org_id?: string;
        payment_type?: string;
        credits_earned?: number;
        agent_id?: string;
        agent_name?: string;
        model?: string;
        tokens?: number;
        protocol?: string;
        type?: string;
      }>()
      .default({})
      .notNull(),

    // Timestamp (immutable)
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    user_idx: index("redeemable_earnings_ledger_user_idx").on(table.user_id),
    user_created_idx: index("redeemable_earnings_ledger_user_created_idx").on(
      table.user_id,
      table.created_at,
    ),
    entry_type_idx: index("redeemable_earnings_ledger_type_idx").on(table.entry_type),
    redemption_idx: index("redeemable_earnings_ledger_redemption_idx").on(table.redemption_id),
    source_idx: index("redeemable_earnings_ledger_source_idx").on(
      table.earnings_source,
      table.source_id,
    ),
  }),
);

/**
 * Tracks which specific earnings have been redeemed
 *
 * This provides a second layer of protection against double-redemption.
 * Each earning transaction can only be redeemed ONCE.
 */
export const redeemedEarningsTracking = pgTable(
  "redeemed_earnings_tracking",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // The original earning ledger entry
    ledger_entry_id: uuid("ledger_entry_id").notNull().unique(), // Each earning can only be redeemed once

    // The redemption that consumed this earning
    redemption_id: uuid("redemption_id").notNull(),

    // Amount from this earning used in redemption
    amount_redeemed: numeric("amount_redeemed", {
      precision: 18,
      scale: 4,
    }).notNull(),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // CRITICAL: Unique constraint ensures each earning is redeemed only once
    ledger_unique: uniqueIndex("redeemed_tracking_ledger_idx").on(table.ledger_entry_id),
    redemption_idx: index("redeemed_tracking_redemption_idx").on(table.redemption_id),
  }),
);

// Type exports
export type RedeemableEarnings = InferSelectModel<typeof redeemableEarnings>;
export type NewRedeemableEarnings = InferInsertModel<typeof redeemableEarnings>;
export type RedeemableEarningsLedger = InferSelectModel<typeof redeemableEarningsLedger>;
export type NewRedeemableEarningsLedger = InferInsertModel<typeof redeemableEarningsLedger>;
export type RedeemedEarningsTracking = InferSelectModel<typeof redeemedEarningsTracking>;
export type NewRedeemedEarningsTracking = InferInsertModel<typeof redeemedEarningsTracking>;
