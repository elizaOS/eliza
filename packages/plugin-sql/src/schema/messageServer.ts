import { getSchemaFactory } from './factory';
import { sql } from 'drizzle-orm';

const factory = getSchemaFactory();

export const messageServerTable = (factory.table as any)('message_servers', {
  id: factory.text('id').primaryKey(), // UUID stored as text
  name: factory.text('name').notNull(),
  sourceType: factory.text('source_type').notNull(),
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

// Relations will be added after creating the other tables
