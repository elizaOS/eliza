import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { Metadata } from '@elizaos/core';
import { channelTable } from './channel';

export const messageTable = pgTable('central_messages', {
  id: text('id').primaryKey(), // UUID stored as text
  channelId: text('channel_id')
    .notNull()
    .references(() => channelTable.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull(),
  content: text('content').notNull(),
  rawMessage: jsonb('raw_message'),
  inReplyToRootMessageId: text('in_reply_to_root_message_id').references(() => messageTable.id, {
    onDelete: 'set null',
  }),
  sourceType: text('source_type'),
  sourceId: text('source_id'),
  metadata: jsonb('metadata').$type<Metadata>(),
  createdAt: timestamp('created_at', { mode: 'date' })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});
