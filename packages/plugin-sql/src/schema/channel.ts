import { pgTable, text, jsonb, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { messageServerTable } from './messageServer';

export const channelTable = pgTable('channels', {
  id: text('id').primaryKey(), // UUID stored as text
  messageServerId: uuid('server_id')
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
});
