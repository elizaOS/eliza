import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  boolean,
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
import { apps } from "./apps";
import { users } from "./users";

/**
 * Supported blockchain networks for token redemptions.
 */
export const redemptionNetworkEnum = pgEnum("redemption_network", [
  "ethereum",
  "base",
  "bnb",
  "solana",
]);

/**
 * Status of a token redemption request.
 * Follows a strict state machine to prevent double-processing.
 */
export const redemptionStatusEnum = pgEnum("redemption_status", [
  "pending", // Initial state, awaiting processing
  "approved", // Approved by system/admin, ready for payout
  "processing", // Currently being processed (locked)
  "completed", // Successfully paid out
  "failed", // Payout failed (can be retried)
  "rejected", // Rejected by admin or security check
  "expired", // Request expired without processing
]);

/**
 * Token redemption requests table schema.
 *
 * Tracks user requests to convert points to elizaOS tokens.
 *
 * SECURITY CONSIDERATIONS:
 * 1. Uses row-level locking (FOR UPDATE) during processing to prevent double-spend
 * 2. Stores price quote with expiry to prevent price manipulation
 * 3. Requires signature verification for payout address
 * 4. Tracks all state transitions with timestamps
 * 5. Supports admin approval workflow for large amounts
 */
export const tokenRedemptions = pgTable(
  "token_redemptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // User making the redemption
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Optional: App from which points are being redeemed
    app_id: uuid("app_id").references(() => apps.id, { onDelete: "set null" }),

    // Amount in points (1 point = 1 cent USD)
    points_amount: numeric("points_amount", {
      precision: 12,
      scale: 2,
    }).notNull(),

    // USD value (points_amount / 100)
    usd_value: numeric("usd_value", { precision: 12, scale: 4 }).notNull(),

    // elizaOS token price at time of quote (USD per token)
    eliza_price_usd: numeric("eliza_price_usd", {
      precision: 18,
      scale: 8,
    }).notNull(),

    // Calculated elizaOS tokens to send
    eliza_amount: numeric("eliza_amount", {
      precision: 24,
      scale: 8,
    }).notNull(),

    // Price quote expiry (typically 5 minutes from creation)
    price_quote_expires_at: timestamp("price_quote_expires_at").notNull(),

    // Target network for payout
    network: redemptionNetworkEnum("network").notNull(),

    // Payout destination address (validated format)
    payout_address: text("payout_address").notNull(),

    // Signature of payout address by user's wallet (verification)
    address_signature: text("address_signature"),

    // Current status
    status: redemptionStatusEnum("status").notNull().default("pending"),

    // Processing details
    processing_started_at: timestamp("processing_started_at"),
    processing_worker_id: text("processing_worker_id"), // For distributed locking

    // Completion details
    tx_hash: text("tx_hash"),
    completed_at: timestamp("completed_at"),

    // Failure details
    failure_reason: text("failure_reason"),
    retry_count: numeric("retry_count", { precision: 3, scale: 0 }).notNull().default("0"),

    // Admin review
    requires_review: boolean("requires_review").notNull().default(false),
    reviewed_by: uuid("reviewed_by").references(() => users.id),
    reviewed_at: timestamp("reviewed_at"),
    review_notes: text("review_notes"),

    // Metadata for audit trail
    metadata: jsonb("metadata")
      .$type<{
        user_agent?: string;
        ip_address?: string;
        price_source?: string;
        original_balance?: number;
        balance_after?: number;
        gas_used?: string;
        gas_price?: string;
        block_number?: number;
        idempotency_key?: string;
        twap_sample_count?: number;
        twap_volatility?: number;
        ledger_entry_id?: string;
        earnings_source?: string;
      }>()
      .default({})
      .notNull(),

    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    user_idx: index("token_redemptions_user_idx").on(table.user_id),
    app_idx: index("token_redemptions_app_idx").on(table.app_id),
    status_idx: index("token_redemptions_status_idx").on(table.status),
    status_created_idx: index("token_redemptions_status_created_idx").on(
      table.status,
      table.created_at,
    ),
    network_idx: index("token_redemptions_network_idx").on(table.network),
    payout_address_idx: index("token_redemptions_payout_idx").on(table.payout_address),
    // Unique constraint to prevent duplicate pending requests
    pending_user_unique: uniqueIndex("token_redemptions_pending_user_idx")
      .on(table.user_id, table.status)
      .where(sql`status = 'pending'`), // Only one pending per user
  }),
);

/**
 * Daily redemption limits table.
 *
 * Tracks daily redemption totals per user for rate limiting.
 */
export const redemptionLimits = pgTable(
  "redemption_limits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: timestamp("date").notNull(),
    daily_usd_total: numeric("daily_usd_total", { precision: 12, scale: 2 })
      .notNull()
      .default("0.00"),
    redemption_count: numeric("redemption_count", { precision: 5, scale: 0 })
      .notNull()
      .default("0"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    user_date_unique: uniqueIndex("redemption_limits_user_date_idx").on(table.user_id, table.date),
  }),
);

/**
 * elizaOS token price cache table.
 *
 * Caches token prices to reduce API calls and provide price consistency.
 */
export const elizaTokenPrices = pgTable(
  "eliza_token_prices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    network: text("network").notNull(),
    price_usd: numeric("price_usd", { precision: 18, scale: 8 }).notNull(),
    source: text("source").notNull(), // e.g., "coingecko", "dexscreener", "jupiter"
    fetched_at: timestamp("fetched_at").notNull().defaultNow(),
    expires_at: timestamp("expires_at").notNull(),
    metadata: jsonb("metadata")
      .$type<{
        volume_24h?: number;
        market_cap?: number;
        price_change_24h?: number;
        is_twap_sample?: boolean;
      }>()
      .default({})
      .notNull(),
  },
  (table) => ({
    network_source_idx: index("eliza_token_prices_network_source_idx").on(
      table.network,
      table.source,
    ),
    expires_idx: index("eliza_token_prices_expires_idx").on(table.expires_at),
  }),
);

export type TokenRedemption = InferSelectModel<typeof tokenRedemptions>;
export type NewTokenRedemption = InferInsertModel<typeof tokenRedemptions>;
export type RedemptionLimit = InferSelectModel<typeof redemptionLimits>;
export type NewRedemptionLimit = InferInsertModel<typeof redemptionLimits>;
export type ElizaTokenPrice = InferSelectModel<typeof elizaTokenPrices>;
export type NewElizaTokenPrice = InferInsertModel<typeof elizaTokenPrices>;
