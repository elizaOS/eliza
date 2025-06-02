import { sql } from 'drizzle-orm';
import { getSchemaFactory } from './factory';
import { agentTable } from './agent';
import { entityTable } from './entity';
import { roomTable } from './room';
import { numberTimestamp } from './types';
import { index as pgIndex, foreignKey as pgForeignKey } from 'drizzle-orm/pg-core';
import { index as sqliteIndex, foreignKey as sqliteForeignKey } from 'drizzle-orm/sqlite-core';

const factory = getSchemaFactory();

/**
 * Defines the schema for the "participants" table in the database.
 *
 * @type {import('knex').TableBuilder}
 */
export const participantTable = (factory.table as any)(
  'participants',
  {
    id: factory
      .uuid('id')
      .notNull()
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    createdAt: numberTimestamp('createdAt').default(factory.defaultTimestamp()).notNull(),
    entityId: factory.uuid('entityId').references(() => entityTable.id, {
      onDelete: 'cascade',
    }),
    roomId: factory.uuid('roomId').references(() => roomTable.id, {
      onDelete: 'cascade',
    }),
    agentId: factory.uuid('agentId').references(() => agentTable.id, {
      onDelete: 'cascade',
    }),
    roomState: factory.text('roomState'),
  },
  (table) => {
    const constraints: any = {};
    if (factory.dbType === 'postgres') {
      constraints.idx_participants_user = pgIndex('idx_participants_user').on(table.entityId);
      constraints.idx_participants_room = pgIndex('idx_participants_room').on(table.roomId);
      constraints.fk_room = pgForeignKey({
        name: 'fk_room',
        columns: [table.roomId],
        foreignColumns: [roomTable.id],
      }).onDelete('cascade');
      constraints.fk_user = pgForeignKey({
        name: 'fk_user',
        columns: [table.entityId],
        foreignColumns: [entityTable.id],
      }).onDelete('cascade');
    } else {
      constraints.idx_participants_user = sqliteIndex('idx_participants_user_sqlite').on(
        table.entityId
      );
      constraints.idx_participants_room = sqliteIndex('idx_participants_room_sqlite').on(
        table.roomId
      );
    }
    return constraints;
  }
);
