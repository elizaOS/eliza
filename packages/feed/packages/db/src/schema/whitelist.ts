import { relations } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Whitelist - Stores individually whitelisted users who bypass NFT gating.
 *
 * Users can be whitelisted via:
 * - `snapshot_first_100`: Imported from end-of-year top-100 snapshot
 * - `admin_manual`: Manually added by an admin
 * - `leaderboard`: Added via leaderboard-based bulk import
 *
 * Soft-revoke via `revokedAt` preserves audit trail.
 */
export const whitelist = pgTable(
  'Whitelist',
  {
    id: text('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    source: text('source')
      .notNull()
      .$type<'snapshot_first_100' | 'admin_manual' | 'leaderboard'>(),
    reason: text('reason'),
    grantedBy: text('grantedBy').references(() => users.id, {
      onDelete: 'set null',
    }),
    grantedAt: timestamp('grantedAt', { mode: 'date' }).notNull().defaultNow(),
    revokedAt: timestamp('revokedAt', { mode: 'date' }),
  },
  (table) => [
    index('Whitelist_userId_idx').on(table.userId),
    index('Whitelist_source_idx').on(table.source),
    index('Whitelist_revokedAt_idx').on(table.revokedAt),
  ]
);

export type WhitelistRow = typeof whitelist.$inferSelect;
export type NewWhitelistRow = typeof whitelist.$inferInsert;

/**
 * WhitelistConfig - Singleton configuration for whitelist settings.
 *
 * Stores global settings such as the leaderboard rank threshold.
 * Uses a singleton pattern (id is always 'default').
 */
export const whitelistConfig = pgTable('WhitelistConfig', {
  id: text('id').primaryKey(), // always 'default'
  leaderboardRankThreshold: integer('leaderboardRankThreshold'), // null = disabled
  leaderboardCategory: text('leaderboardCategory').notNull().default('all'),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().defaultNow(),
  updatedBy: text('updatedBy').references(() => users.id, {
    onDelete: 'set null',
  }),
});

export type WhitelistConfigRow = typeof whitelistConfig.$inferSelect;
export type NewWhitelistConfigRow = typeof whitelistConfig.$inferInsert;

// Relations
export const whitelistRelations = relations(whitelist, ({ one }) => ({
  user: one(users, {
    fields: [whitelist.userId],
    references: [users.id],
  }),
  granter: one(users, {
    fields: [whitelist.grantedBy],
    references: [users.id],
    relationName: 'Whitelist_grantedByToUser',
  }),
}));

export const whitelistConfigRelations = relations(
  whitelistConfig,
  ({ one }) => ({
    updater: one(users, {
      fields: [whitelistConfig.updatedBy],
      references: [users.id],
    }),
  })
);
