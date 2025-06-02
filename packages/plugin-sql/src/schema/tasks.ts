import { sql } from 'drizzle-orm';
import { getSchemaFactory } from './factory';
import { numberTimestamp } from './types';

const factory = getSchemaFactory();

/**
 * Represents a table schema for tasks in the database.
 *
 * @type {PgTable}
 */
export const taskTable = (factory.table as any)('tasks', {
  id: factory
    .uuid('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: factory.text('name').notNull(),
  description: factory.text('description'),
  roomId: factory.uuid('roomId'),
  worldId: factory.uuid('worldId'),
  entityId: factory.uuid('entityId'),
  agentId: factory.uuid('agent_id').notNull(),
  tags: factory.textArray('tags').default(sql`'[]'`),
  metadata: factory.json('metadata').default(sql`'{}'`),
  createdAt: numberTimestamp('created_at').default(factory.defaultTimestamp()),
  updatedAt: numberTimestamp('updated_at').default(factory.defaultTimestamp()),
});
