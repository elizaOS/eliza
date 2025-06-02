import { sql } from 'drizzle-orm';
import { getSchemaFactory } from './factory';
import { agentTable } from './agent';
import { entityTable } from './entity';
import { roomTable } from './room';
import { numberTimestamp } from './types';
import { worldTable } from './world';

const factory = getSchemaFactory();

/**
 * Definition of a table representing components in the database.
 *
 * @type {Table}
 */
export const componentTable = (factory.table as any)('components', {
  id: factory
    .uuid('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  entityId: factory
    .uuid('entityId')
    .notNull()
    .references(() => entityTable.id, { onDelete: 'cascade' }),
  agentId: factory
    .uuid('agentId')
    .notNull()
    .references(() => agentTable.id, { onDelete: 'cascade' }),
  roomId: factory
    .uuid('roomId')
    .notNull()
    .references(() => roomTable.id, { onDelete: 'cascade' }),
  worldId: factory.uuid('worldId').references(() => worldTable.id, {
    onDelete: 'cascade',
  }),
  sourceEntityId: factory.uuid('sourceEntityId').references(() => entityTable.id, {
    onDelete: 'cascade',
  }),
  type: factory.text('type').notNull(),
  data: factory.json('data').default(sql`'{}'`),
  createdAt: numberTimestamp('createdAt').default(factory.defaultTimestamp()).notNull(),
});
