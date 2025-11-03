import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agentTable } from './agent';
import { entityTable } from './entity';
import { roomTable } from './room';
import { worldTable } from './world';

/**
 * Represents a component table in the database.
 */
export const componentTable = pgTable('components', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`)
    .notNull(),

  // Foreign keys
  entityId: uuid('entityId')
    .references(() => entityTable.id, { onDelete: 'cascade' })
    .notNull(),
  agentId: uuid('agentId')
    .references(() => agentTable.id, { onDelete: 'cascade' })
    .notNull(),
  roomId: uuid('roomId')
    .references(() => roomTable.id, { onDelete: 'cascade' })
    .notNull(),
  worldId: uuid('worldId').references(() => worldTable.id, { onDelete: 'cascade' }),
  sourceEntityId: uuid('sourceEntityId').references(() => entityTable.id, { onDelete: 'cascade' }),

  // Data
  type: text('type').notNull(),
  data: jsonb('data').default(sql`'{}'::jsonb`),

  // Timestamps
  createdAt: timestamp('createdAt')
    .default(sql`now()`)
    .notNull(),
});
