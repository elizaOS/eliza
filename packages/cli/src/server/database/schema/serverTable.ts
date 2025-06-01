import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { channelTable } from './channelTable';

export const messageServerTable = pgTable('servers', {
  id: text('id').primaryKey(), // UUID stored as text
  name: text('name').notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: text('source_id'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { mode: 'date' })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export const messageServerRelations = relations(messageServerTable, ({ many }) => ({
  channels: many(channelTable),
}));
