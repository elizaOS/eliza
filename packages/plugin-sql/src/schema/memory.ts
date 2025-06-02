import { relations, sql } from 'drizzle-orm';
import { getSchemaFactory } from './factory';
import { agentTable } from './agent';
import { embeddingTable } from './embedding';
import { entityTable } from './entity';
import { roomTable } from './room';
import { numberTimestamp } from './types';
import {
  check as pgCheck,
  foreignKey as pgForeignKey,
  index as pgIndex,
} from 'drizzle-orm/pg-core';
import { index as sqliteIndex } from 'drizzle-orm/sqlite-core';

const factory = getSchemaFactory();

/**
 * Definition of the memory table in the database.
 *
 * @param {string} tableName - The name of the table.
 * @param {object} columns - An object containing the column definitions.
 * @param {function} indexes - A function that defines the indexes for the table.
 * @returns {object} - The memory table object.
 */
export const memoryTable = (factory.table as any)(
  'memories',
  {
    id: factory
      .uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    type: factory.text('type').notNull(),
    createdAt: numberTimestamp('createdAt').default(factory.defaultTimestamp()).notNull(),
    content: factory.json('content').notNull(),
    entityId: factory.uuid('entityId').references(() => entityTable.id, {
      onDelete: 'cascade',
    }),
    agentId: factory
      .uuid('agentId')
      .references(() => agentTable.id, {
        onDelete: 'cascade',
      })
      .notNull(),
    roomId: factory.uuid('roomId').references(() => roomTable.id, {
      onDelete: 'cascade',
    }),
    worldId: factory.uuid('worldId'),
    unique: factory.boolean('unique').default(true).notNull(),
    metadata: factory
      .json('metadata')
      .default(sql`'{}'`)
      .notNull(),
  },
  (table) => {
    const constraints: any = {};
    if (factory.dbType === 'postgres') {
      constraints.idx_type_room = pgIndex('idx_memories_type_room_pg').on(table.type, table.roomId);
      constraints.idx_world_id = pgIndex('idx_memories_world_id_pg').on(table.worldId);
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
      constraints.fk_agent = pgForeignKey({
        name: 'fk_agent',
        columns: [table.agentId],
        foreignColumns: [agentTable.id],
      }).onDelete('cascade');
      constraints.idx_metadata_type = pgIndex('idx_memories_metadata_type_pg').on(
        sql`((metadata->>'type'))`
      );
      constraints.idx_document_id = pgIndex('idx_memories_document_id_pg').on(
        sql`((metadata->>'documentId'))`
      );
      constraints.idx_fragments_order = pgIndex('idx_fragments_order_pg').on(
        sql`((metadata->>'documentId'))`,
        sql`((metadata->>'position'))`
      );
      constraints.fragment_metadata_check = pgCheck(
        'fragment_metadata_check_pg',
        sql`CASE WHEN metadata->>'type' = 'fragment' THEN metadata ? 'documentId' AND metadata ? 'position' ELSE true END`
      );
      constraints.document_metadata_check = pgCheck(
        'document_metadata_check_pg',
        sql`CASE WHEN metadata->>'type' = 'document' THEN metadata ? 'timestamp' ELSE true END`
      );
    } else {
      constraints.idx_type_room = sqliteIndex('idx_memories_type_room_sqlite').on(
        table.type,
        table.roomId
      );
      constraints.idx_world_id = sqliteIndex('idx_memories_world_id_sqlite').on(table.worldId);
      console.warn(
        "Complex JSON indexes and CHECK constraints for 'memories' metadata are simplified/omitted for SQLite."
      );
    }
    return constraints;
  }
);

export const memoryRelations = relations(memoryTable, ({ one }) => ({
  embedding: one(embeddingTable, {
    fields: [memoryTable.id],
    references: [embeddingTable.memoryId],
  }),
}));
