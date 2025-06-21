import { getSchemaFactory } from './factory';

/**
 * Lazy-loaded message server table definition.
 * This function returns the message server table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createMessageServerTable() {
  const factory = getSchemaFactory();
  
  return factory.table('message_servers', {
    id: factory.text('id').primaryKey(), // UUID stored as text
    name: factory.text('name').notNull(),
    sourceType: factory.text('source_type').notNull(),
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
let _messageServerTable: any = null;

/**
 * Represents the message server table in the database.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const messageServerTable = new Proxy({} as any, {
  get(target, prop, receiver) {
    if (!_messageServerTable) {
      _messageServerTable = createMessageServerTable();
    }
    return Reflect.get(_messageServerTable, prop, receiver);
  }
});
