import { sql } from 'drizzle-orm';
import { foreignKey, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { entityTable } from './entity';
import { roomTable } from './room';

/**
 * Represents a PostgreSQL table for storing logs.
 *
 * @type {Table}
 */

export const logTable = pgTable(
  'logs',
  {
    id: uuid('id').defaultRandom().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
    entityId: uuid('entityId')
      .notNull()
      .references(() => entityTable.id, { onDelete: 'cascade' }),
    body: jsonb('body').notNull(),
    type: text('type').notNull(),
    roomId: uuid('roomId')
      .notNull()
      .references(() => roomTable.id, { onDelete: 'cascade' }),
  },
  (table) => [
    foreignKey({
      name: 'fk_room',
      columns: [table.roomId],
      foreignColumns: [roomTable.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_user',
      columns: [table.entityId],
      foreignColumns: [entityTable.id],
    }).onDelete('cascade'),
  ]
);
