import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { agentTable } from './agent';
import { entityTable } from './entity';
import { roomTable } from './room';
import { numberTimestamp } from './types';
import { worldTable } from './world';

/**
 * Definition of a table representing components in the database.
 *
 * @type {Table}
 */
export const componentTable = pgTable('components', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entityId')
    .notNull()
    .references(() => entityTable.id, { onDelete: 'cascade' }),
  agentId: uuid('agentId')
    .notNull()
    .references(() => agentTable.id, { onDelete: 'cascade' }),
  roomId: uuid('roomId')
    .notNull()
    .references(() => roomTable.id, { onDelete: 'cascade' }),
  worldId: uuid('worldId').references(() => worldTable.id, {
    onDelete: 'cascade',
  }),
  sourceEntityId: uuid('sourceEntityId').references(() => entityTable.id, {
    onDelete: 'cascade',
  }),
  type: text('type').notNull(),
  data: jsonb('data').default(sql`'{}'::jsonb`),
  createdAt: numberTimestamp('createdAt')
    .default(sql`now()`)
    .notNull(),
});
