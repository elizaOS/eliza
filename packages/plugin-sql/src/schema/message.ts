import { getSchemaFactory } from './factory';
import { channelTable } from './channel';

const factory = getSchemaFactory();

export const messageTable = (factory.table as any)('central_messages', {
  id: factory.text('id').primaryKey(), // UUID stored as text
  channelId: factory
    .text('channel_id')
    .notNull()
    .references(() => channelTable.id, { onDelete: 'cascade' }),
  authorId: factory.text('author_id').notNull(),
  content: factory.text('content').notNull(),
  rawMessage: factory.json('raw_message'),
  inReplyToRootMessageId: factory
    .text('in_reply_to_root_message_id')
    .references(() => messageTable.id, {
      onDelete: 'set null',
    }),
  sourceType: factory.text('source_type'),
  sourceId: factory.text('source_id'),
  metadata: factory.json('metadata'),
  createdAt: factory
    .timestamp('created_at', { mode: 'date' })
    .default(factory.defaultTimestamp())
    .notNull(),
  updatedAt: factory
    .timestamp('updated_at', { mode: 'date' })
    .default(factory.defaultTimestamp())
    .notNull(),
});
