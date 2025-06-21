import { getSchemaFactory } from './factory';
import { channelTable } from './channel';

/**
 * Lazy-loaded message table definition.
 * This function returns the message table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createMessageTable() {
  const factory = getSchemaFactory();
  
  return factory.table('central_messages', {
    id: factory.text('id').primaryKey(), // UUID stored as text
    channelId: factory.text('channel_id')
      .notNull()
      .references(() => channelTable.id, { onDelete: 'cascade' }),
    authorId: factory.text('author_id').notNull(),
    content: factory.text('content').notNull(),
    rawMessage: factory.json('raw_message'),
    inReplyToRootMessageId: factory.text('in_reply_to_root_message_id').references(() => messageTable.id, {
      onDelete: 'set null',
    }),
    sourceType: factory.text('source_type'),
    sourceId: factory.text('source_id'),
    metadata: factory.json('metadata'),
    createdAt: factory.timestamp('created_at', { mode: 'date' })
      .default(factory.defaultTimestamp())
      .notNull(),
    updatedAt: factory.timestamp('updated_at', { mode: 'date' })
      .default(factory.defaultTimestamp())
      .notNull(),
  });
}

// Cache the table once created
let _messageTable: any = null;

/**
 * Represents the message table in the database.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const messageTable = new Proxy({} as any, {
  get(target, prop, receiver) {
    if (!_messageTable) {
      _messageTable = createMessageTable();
    }
    return Reflect.get(_messageTable, prop, receiver);
  }
});
