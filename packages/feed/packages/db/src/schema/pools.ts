import { relations } from 'drizzle-orm';
import {
  boolean,
  decimal,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { npcTrades } from './actors';

// Pool
export const pools = pgTable(
  'Pool',
  {
    id: text('id').primaryKey(),
    npcActorId: text('npcActorId').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    totalValue: decimal('totalValue', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    totalDeposits: decimal('totalDeposits', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    availableBalance: decimal('availableBalance', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    lifetimePnL: decimal('lifetimePnL', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    performanceFeeRate: doublePrecision('performanceFeeRate')
      .notNull()
      .default(0.05),
    totalFeesCollected: decimal('totalFeesCollected', {
      precision: 18,
      scale: 2,
    })
      .notNull()
      .default('0'),
    isActive: boolean('isActive').notNull().default(true),
    openedAt: timestamp('openedAt', { mode: 'date' }).notNull().defaultNow(),
    closedAt: timestamp('closedAt', { mode: 'date' }),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull(),
    currentPrice: doublePrecision('currentPrice'),
    priceChange24h: doublePrecision('priceChange24h'),
    status: text('status').notNull().default('ACTIVE'),
    tvl: decimal('tvl', { precision: 18, scale: 2 }),
    volume24h: decimal('volume24h', { precision: 18, scale: 2 }),
  },
  (table) => [
    index('Pool_isActive_idx').on(table.isActive),
    index('Pool_npcActorId_idx').on(table.npcActorId),
    index('Pool_status_idx').on(table.status),
    index('Pool_totalValue_idx').on(table.totalValue),
    index('Pool_volume24h_idx').on(table.volume24h),
  ]
);

// PoolDeposit
export const poolDeposits = pgTable(
  'PoolDeposit',
  {
    id: text('id').primaryKey(),
    poolId: text('poolId').notNull(),
    userId: text('userId').notNull(),
    amount: decimal('amount', { precision: 18, scale: 2 }).notNull(),
    shares: decimal('shares', { precision: 18, scale: 6 }).notNull(),
    currentValue: decimal('currentValue', {
      precision: 18,
      scale: 2,
    }).notNull(),
    unrealizedPnL: decimal('unrealizedPnL', {
      precision: 18,
      scale: 2,
    }).notNull(),
    depositedAt: timestamp('depositedAt', { mode: 'date' })
      .notNull()
      .defaultNow(),
    withdrawnAt: timestamp('withdrawnAt', { mode: 'date' }),
    withdrawnAmount: decimal('withdrawnAmount', { precision: 18, scale: 2 }),
  },
  (table) => [
    index('PoolDeposit_poolId_userId_idx').on(table.poolId, table.userId),
    index('PoolDeposit_poolId_withdrawnAt_idx').on(
      table.poolId,
      table.withdrawnAt
    ),
    index('PoolDeposit_userId_depositedAt_idx').on(
      table.userId,
      table.depositedAt
    ),
  ]
);

// PoolPosition
export const poolPositions = pgTable(
  'PoolPosition',
  {
    id: text('id').primaryKey(),
    poolId: text('poolId').notNull(),
    marketType: text('marketType').notNull(),
    ticker: text('ticker'),
    marketId: text('marketId'),
    side: text('side').notNull(),
    entryPrice: doublePrecision('entryPrice').notNull(),
    currentPrice: doublePrecision('currentPrice').notNull(),
    size: doublePrecision('size').notNull(),
    shares: doublePrecision('shares'),
    leverage: integer('leverage'),
    liquidationPrice: doublePrecision('liquidationPrice'),
    unrealizedPnL: doublePrecision('unrealizedPnL').notNull(),
    openedAt: timestamp('openedAt', { mode: 'date' }).notNull().defaultNow(),
    closedAt: timestamp('closedAt', { mode: 'date' }),
    realizedPnL: doublePrecision('realizedPnL'),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull(),
  },
  (table) => [
    index('PoolPosition_marketType_marketId_idx').on(
      table.marketType,
      table.marketId
    ),
    index('PoolPosition_marketType_ticker_idx').on(
      table.marketType,
      table.ticker
    ),
    index('PoolPosition_poolId_closedAt_idx').on(table.poolId, table.closedAt),
  ]
);

// Relations
// Note: npcActorId references actor IDs from StaticDataRegistry (static) and actorState (dynamic)
export const poolsRelations = relations(pools, ({ many }) => ({
  PoolDeposit: many(poolDeposits),
  PoolPosition: many(poolPositions),
  NPCTrade: many(npcTrades),
}));

export const poolDepositsRelations = relations(poolDeposits, ({ one }) => ({
  pool: one(pools, {
    fields: [poolDeposits.poolId],
    references: [pools.id],
  }),
}));

export const poolPositionsRelations = relations(poolPositions, ({ one }) => ({
  pool: one(pools, {
    fields: [poolPositions.poolId],
    references: [pools.id],
  }),
}));

// Type exports
export type Pool = typeof pools.$inferSelect;
export type NewPool = typeof pools.$inferInsert;
export type PoolDeposit = typeof poolDeposits.$inferSelect;
export type NewPoolDeposit = typeof poolDeposits.$inferInsert;
export type PoolPosition = typeof poolPositions.$inferSelect;
export type NewPoolPosition = typeof poolPositions.$inferInsert;
