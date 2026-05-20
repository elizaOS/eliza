import { relations } from 'drizzle-orm';
import {
  decimal,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Wallet Transfer Log — Audit trail for all on-chain transfers initiated through Feed.
 * Records both pending and completed/failed transfers for user-facing transaction history
 * and security auditing.
 */
export const walletTransferLog = pgTable(
  'WalletTransferLog',
  {
    id: text('id').primaryKey(),
    userId: text('userId').notNull(),
    fromAddress: text('fromAddress').notNull(),
    toAddress: text('toAddress').notNull(),
    tokenAddress: text('tokenAddress'), // null for native ETH
    tokenId: text('tokenId'), // for NFT transfers
    amount: text('amount').notNull(), // raw value in wei/units
    txHash: text('txHash'),
    chainId: integer('chainId').notNull(),
    status: text('status').notNull(), // 'pending' | 'confirmed' | 'failed'
    type: text('type').notNull(), // 'native' | 'erc20' | 'erc721'
    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmedAt', { mode: 'date' }),
    usdValueAtTime: decimal('usdValueAtTime', { precision: 18, scale: 2 }),
    ipAddress: text('ipAddress'),
  },
  (table) => [
    index('WalletTransferLog_userId_idx').on(table.userId),
    index('WalletTransferLog_userId_createdAt_idx').on(
      table.userId,
      table.createdAt
    ),
    index('WalletTransferLog_fromAddress_idx').on(table.fromAddress),
    index('WalletTransferLog_toAddress_idx').on(table.toAddress),
    index('WalletTransferLog_txHash_idx').on(table.txHash),
    index('WalletTransferLog_status_idx').on(table.status),
  ]
);

export const walletTransferLogRelations = relations(
  walletTransferLog,
  ({ one }) => ({
    user: one(users, {
      fields: [walletTransferLog.userId],
      references: [users.id],
    }),
  })
);

/**
 * Wallet Transfer Limits — Daily spending limits for wallet transfers.
 * Uses check-on-read pattern for daily reset (no cron required).
 */
export const walletTransferLimit = pgTable('WalletTransferLimit', {
  userId: text('userId').primaryKey(),
  dailyLimitUsd: decimal('dailyLimitUsd', { precision: 18, scale: 2 })
    .notNull()
    .default('1000.00'),
  dailySpentUsd: decimal('dailySpentUsd', { precision: 18, scale: 2 })
    .notNull()
    .default('0.00'),
  lastResetAt: timestamp('lastResetAt', { mode: 'date' })
    .notNull()
    .defaultNow(),
  elevatedUntil: timestamp('elevatedUntil', { mode: 'date' }),
  elevatedLimitUsd: decimal('elevatedLimitUsd', { precision: 18, scale: 2 }),
});

export const walletTransferLimitRelations = relations(
  walletTransferLimit,
  ({ one }) => ({
    user: one(users, {
      fields: [walletTransferLimit.userId],
      references: [users.id],
    }),
  })
);
