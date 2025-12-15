import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agentTable } from './agent';

/**
 * Represents a table schema for tasks in the database.
 *
 * @type {PgTable}
 */
export const taskTable = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  roomId: uuid('room_id'),
  worldId: uuid('world_id'),
  entityId: uuid('entity_id'),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agentTable.id, { onDelete: 'cascade' }),
  tags: text('tags')
    .array()
    .default(sql`'{}'::text[]`),
  metadata: jsonb('metadata').default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
