import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { channelTable } from './channelTable';

export const centralRootMessageTable = pgTable(
  'messages',
  {
    id: text('id').primaryKey(), // UUID stored as text
    channelId: text('channel_id')
      .notNull()
      .references(() => channelTable.id, { onDelete: 'cascade' }),
    authorId: text('author_id').notNull(), // UUID stored as text
    content: text('content').notNull(),
    rawMessage: jsonb('raw_message'),
    inReplyToRootMessageId: text('in_reply_to_root_message_id').references(
      () => centralRootMessageTable.id,
      { onDelete: 'set null' }
    ),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  }
  // Add indexes as needed, e.g., on channelId, authorId, createdAt
);

export const centralRootMessageRelations = relations(centralRootMessageTable, ({ one, many }) => ({
  channel: one(channelTable, {
    fields: [centralRootMessageTable.channelId],
    references: [channelTable.id],
  }),
  parentMessage: one(centralRootMessageTable, {
    fields: [centralRootMessageTable.inReplyToRootMessageId],
    references: [centralRootMessageTable.id],
    relationName: 'repliesToRoot',
  }),
  replies: many(centralRootMessageTable, {
    relationName: 'repliesToRoot',
  }),
}));
