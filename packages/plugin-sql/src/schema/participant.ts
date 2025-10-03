import { sql } from 'drizzle-orm';
import { foreignKey, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agentTable } from './agent';
import { entityTable } from './entity';
import { roomTable } from './room';

/**
 * Defines the schema for the "participants" table in the database.
 *
 * @type {import('knex').TableBuilder}
 */
export const participantTable = pgTable(
  'participants',
  {
    id: uuid('id')
      .notNull()
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
    entityId: uuid('entityId').references(() => entityTable.id, {
      onDelete: 'cascade',
    }),
    roomId: uuid('roomId').references(() => roomTable.id, {
      onDelete: 'cascade',
    }),
    agentId: uuid('agentId').references(() => agentTable.id, {
      onDelete: 'cascade',
    }),
    roomState: text('roomState'),
    lastRead: timestamp('last_read', { withTimezone: true }), // For unread message tracking
  },
  (table) => [
    // Indexes for efficient queries
    index('idx_participants_entity').on(table.entityId),
    index('idx_participants_room').on(table.roomId),
    index('idx_participants_agent').on(table.agentId),
    // Foreign key constraints
    foreignKey({
      name: 'fk_room',
      columns: [table.roomId],
      foreignColumns: [roomTable.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_entity',
      columns: [table.entityId],
      foreignColumns: [entityTable.id],
    }).onDelete('cascade'),
  ]
);
