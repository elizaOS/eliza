import { sql } from 'drizzle-orm';
import { getSchemaFactory } from './factory';
import { agentTable } from './agent';
import { numberTimestamp } from './types';

const factory = getSchemaFactory();

/**
 * Represents a table schema for worlds in the database.
 *
 * @type {PgTable}
 */

export const worldTable = (factory.table as any)('worlds', {
  id: factory
    .uuid('id')
    .notNull()
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  agentId: factory
    .uuid('agentId')
    .notNull()
    .references(() => agentTable.id, { onDelete: 'cascade' }),
  name: factory.text('name').notNull(),
  metadata: factory.json('metadata'),
  serverId: factory.text('serverId').notNull(),
  createdAt: numberTimestamp('createdAt').default(factory.defaultTimestamp()).notNull(),
});
