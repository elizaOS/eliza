import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { messageServerTable } from './serverTable';
import { centralRootMessageTable } from './messageTable';

export const channelTable = pgTable(
  'channels',
  {
    id: text('id').primaryKey(), // UUID stored as text
    messageServerId: text('server_id')
      .notNull()
      .references(() => messageServerTable.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(), // Store ChannelType enum values as text
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    topic: text('topic'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  }
  // Add indexes as needed, e.g., on messageServerId
);

export const messageChannelRelations = relations(channelTable, ({ one, many }) => ({
  server: one(messageServerTable, {
    fields: [channelTable.messageServerId],
    references: [messageServerTable.id],
  }),
  messages: many(centralRootMessageTable),
}));
