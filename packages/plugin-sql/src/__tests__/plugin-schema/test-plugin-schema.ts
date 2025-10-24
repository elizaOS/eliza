/**
 * Test schema for polymarket plugin using proper pgSchema syntax
 * This is a copy for testing the runtime migrator with namespaced schemas
 */

import { sql } from 'drizzle-orm';
import {
  pgSchema,
  text,
  uuid,
  decimal,
  boolean,
  timestamp,
  integer,
  jsonb,
  index,
  foreignKey,
  unique,
} from 'drizzle-orm/pg-core';

// Create a dedicated schema for the polymarket plugin
export const polymarketSchema = pgSchema('polymarket');

/**
 * Markets table - stores core market information from Polymarket
 * Using array syntax for constraints like core schema does
 */
export const polymarketMarketsTable = polymarketSchema.table(
  'markets',
  {
    // Primary key (internal)
    id: uuid('id').defaultRandom().primaryKey(),

    // Polymarket identifiers - conditionId is unique for foreign key references
    conditionId: text('condition_id').notNull().unique(),
    questionId: text('question_id').notNull(),
    marketSlug: text('market_slug').notNull(),

    // Market content
    question: text('question').notNull(),
    category: text('category'),

    // Dates (ISO strings from API)
    endDateIso: timestamp('end_date_iso', { withTimezone: true }),
    gameStartTime: timestamp('game_start_time', { withTimezone: true }),

    // Status flags
    active: boolean('active').notNull().default(false),
    closed: boolean('closed').notNull().default(false),

    // Trading parameters (strings from API)
    minimumOrderSize: text('minimum_order_size'),
    minimumTickSize: text('minimum_tick_size'),
    minIncentiveSize: text('min_incentive_size'),
    maxIncentiveSpread: text('max_incentive_spread'),
    secondsDelay: integer('seconds_delay').default(0),

    // Metadata
    icon: text('icon'),
    fpmm: text('fpmm'), // Fixed Product Market Maker address

    // Tracking fields
    createdAt: timestamp('created_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  // Use array syntax like core schema
  (table) => [
    // Indexes for common queries
    index('markets_condition_id_idx').on(table.conditionId),
    index('markets_active_idx').on(table.active),
    index('markets_closed_idx').on(table.closed),
    index('markets_category_idx').on(table.category),
    index('markets_end_date_idx').on(table.endDateIso),
    index('markets_last_synced_idx').on(table.lastSyncedAt),
    // Active markets are most commonly queried
    index('markets_active_closed_idx').on(table.active, table.closed),
  ]
);

/**
 * Tokens table - stores YES/NO token information for each market
 */
export const polymarketTokensTable = polymarketSchema.table(
  'tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tokenId: text('token_id').notNull().unique(),
    conditionId: text('condition_id').notNull(),
    outcome: text('outcome').notNull(), // 'YES' or 'NO'

    createdAt: timestamp('created_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    // Foreign key to markets
    foreignKey({
      columns: [table.conditionId],
      foreignColumns: [polymarketMarketsTable.conditionId],
      name: 'fk_tokens_condition_id',
    }).onDelete('cascade'),

    // Indexes
    index('tokens_token_id_idx').on(table.tokenId),
    index('tokens_condition_id_idx').on(table.conditionId),
    index('tokens_outcome_idx').on(table.outcome),
    // Compound index for market + outcome lookups
    index('tokens_condition_outcome_idx').on(table.conditionId, table.outcome),
  ]
);

/**
 * Rewards table - stores reward configuration for markets
 */
export const polymarketRewardsTable = polymarketSchema.table(
  'rewards',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conditionId: text('condition_id').notNull(),

    // Reward parameters (from API)
    minSize: decimal('min_size', { precision: 20, scale: 8 }),
    maxSpread: decimal('max_spread', { precision: 10, scale: 4 }),
    eventStartDate: text('event_start_date'), // Store as ISO string from API
    eventEndDate: text('event_end_date'), // Store as ISO string from API
    inGameMultiplier: decimal('in_game_multiplier', {
      precision: 10,
      scale: 4,
    }),
    rewardEpoch: integer('reward_epoch'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    // Foreign key and unique constraint
    foreignKey({
      columns: [table.conditionId],
      foreignColumns: [polymarketMarketsTable.conditionId],
      name: 'fk_rewards_condition_id',
    }).onDelete('cascade'),

    // One reward config per market
    unique('rewards_condition_id_unique').on(table.conditionId),

    // Index for epoch queries
    index('rewards_epoch_idx').on(table.rewardEpoch),
  ]
);

/**
 * Market prices table - stores current price data for tokens
 */
export const polymarketPricesTable = polymarketSchema.table(
  'prices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tokenId: text('token_id').notNull(),
    conditionId: text('condition_id').notNull(),

    // Price data
    price: decimal('price', { precision: 10, scale: 6 }), // Price from 0 to 1
    bid: decimal('bid', { precision: 10, scale: 6 }),
    ask: decimal('ask', { precision: 10, scale: 6 }),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    // Foreign keys
    foreignKey({
      columns: [table.conditionId],
      foreignColumns: [polymarketMarketsTable.conditionId],
      name: 'fk_prices_condition_id',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tokenId],
      foreignColumns: [polymarketTokensTable.tokenId],
      name: 'fk_prices_token_id',
    }).onDelete('cascade'),

    // Indexes for price lookups
    index('prices_token_id_idx').on(table.tokenId),
    index('prices_condition_id_idx').on(table.conditionId),
    index('prices_updated_at_idx').on(table.updatedAt),
    // Most recent price per token
    index('prices_token_updated_idx').on(table.tokenId, table.updatedAt),
  ]
);

/**
 * Sync status table - tracks sync operations and status
 */
export const polymarketSyncStatusTable = polymarketSchema.table(
  'sync_status',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    syncType: text('sync_type').notNull(), // 'markets', 'prices', 'volume'
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
    syncStatus: text('sync_status').default('pending').notNull(), // 'pending', 'running', 'success', 'error'
    errorMessage: text('error_message'),
    recordsProcessed: integer('records_processed').default(0),

    // Metadata for sync details
    metadata: jsonb('metadata')
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    // Indexes for sync monitoring
    index('sync_status_type_idx').on(table.syncType),
    index('sync_status_last_sync_idx').on(table.lastSyncAt),
    index('sync_status_status_idx').on(table.syncStatus),
    // Latest sync per type
    index('sync_status_type_last_sync_idx').on(table.syncType, table.lastSyncAt),
  ]
);

// Export all tables as schema for migration registration
export const testPolymarketSchema = {
  polymarketMarketsTable,
  polymarketTokensTable,
  polymarketRewardsTable,
  polymarketPricesTable,
  polymarketSyncStatusTable,
};
