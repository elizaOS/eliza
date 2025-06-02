import { sql } from 'drizzle-orm';
import { getSchemaFactory } from './factory';
import { entityTable } from './entity';
import { roomTable } from './room';
import { numberTimestamp } from './types';
import { foreignKey as pgForeignKey } from 'drizzle-orm/pg-core';
import { foreignKey as sqliteForeignKey } from 'drizzle-orm/sqlite-core';

const factory = getSchemaFactory();

/**
 * Represents a PostgreSQL table for storing logs.
 *
 * @type {Table}
 */

export const logTable = (factory.table as any)(
  'logs',
  {
    id: factory
      .uuid('id')
      .$defaultFn(() => crypto.randomUUID())
      .notNull(),
    createdAt: numberTimestamp('createdAt').default(factory.defaultTimestamp()).notNull(),
    entityId: factory
      .uuid('entityId')
      .notNull()
      .references(() => entityTable.id),
    body: factory.json('body').notNull(),
    type: factory.text('type').notNull(),
    roomId: factory
      .uuid('roomId')
      .notNull()
      .references(() => roomTable.id, { onDelete: 'cascade' }),
  },
  (table) => {
    const constraints: any = {};
    if (factory.dbType === 'postgres') {
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
      // For SQLite, foreign keys are handled by the references() calls in the column definitions
    }
    return constraints;
  }
);
