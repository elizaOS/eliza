import { sql } from 'drizzle-orm';
import { foreignKey, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { entityTable } from './entity';
import { roomTable } from './room';

export const logTable = pgTable(
  'logs',
  {
    id: uuid('id').defaultRandom().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entityTable.id, { onDelete: 'cascade' }),
    body: jsonb('body').notNull(),
    type: text('type').notNull(),
    roomId: uuid('room_id')
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
    index('idx_logs_type_created').on(table.type, table.createdAt),
    index('idx_logs_room_created').on(table.roomId, table.createdAt),
  ]
);
