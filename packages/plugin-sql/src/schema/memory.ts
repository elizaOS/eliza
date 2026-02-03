import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Content, Metadata } from '@elizaos/core';
import { agentTable } from './agent';
import { embeddingTable } from './embedding';
import { entityTable } from './entity';
import { roomTable } from './room';

/**
 * Definition of the memory table in the database.
 *
 * @param {string} tableName - The name of the table.
 * @param {object} columns - An object containing the column definitions.
 * @param {function} indexes - A function that defines the indexes for the table.
 * @returns {object} - The memory table object.
 */
export const memoryTable = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().notNull(),
    type: text('type').notNull(),
    createdAt: timestamp('created_at')
      .default(sql`now()`)
      .notNull(),
    content: jsonb('content').$type<Content>().notNull(),
    entityId: uuid('entity_id').references(() => entityTable.id, {
      onDelete: 'cascade',
    }),
    agentId: uuid('agent_id')
      .references(() => agentTable.id, {
        onDelete: 'cascade',
      })
      .notNull(),
    roomId: uuid('room_id').references(() => roomTable.id, {
      onDelete: 'cascade',
    }),
    worldId: uuid('world_id'),
    // .references(() => worldTable.id, {
    //   onDelete: 'set null',
    // }),
    unique: boolean('unique').default(true).notNull(),
    metadata: jsonb('metadata').$type<Metadata>().default({}).notNull(),
  },
  (table) => [
    index('idx_memories_type_room').on(table.type, table.roomId),
    index('idx_memories_world_id').on(table.worldId),
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
    foreignKey({
      name: 'fk_agent',
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete('cascade'),
    // foreignKey({
    //   name: 'fk_world',
    //   columns: [table.worldId],
    //   foreignColumns: [worldTable.id],
    // }).onDelete('set null'),
    index('idx_memories_metadata_type').on(sql`((metadata->>'type'))`),
    index('idx_memories_document_id').on(sql`((metadata->>'documentId'))`),
    index('idx_fragments_order').on(
      sql`((metadata->>'documentId'))`,
      sql`((metadata->>'position'))`
    ),
    check(
      'fragment_metadata_check',
      sql`
            CASE 
                WHEN metadata->>'type' = 'fragment' THEN
                    metadata ? 'documentId' AND 
                    metadata ? 'position'
                ELSE true
            END
        `
    ),
    check(
      'document_metadata_check',
      sql`
            CASE 
                WHEN metadata->>'type' = 'document' THEN
                    metadata ? 'timestamp'
                ELSE true
            END
        `
    ),
  ]
);

export const memoryRelations = relations(memoryTable, ({ one }) => ({
  embedding: one(embeddingTable),
}));
