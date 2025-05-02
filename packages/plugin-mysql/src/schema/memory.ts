import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  json,
  mysqlTable,
  text,
  varchar,
} from 'drizzle-orm/mysql-core';
import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import { Memory, UUID, Content, MemoryMetadata } from '@elizaos/core';
import { agentTable } from './agent';
import { entityTable } from './entity';
import { roomTable } from './room';
import { numberTimestamp } from './types';

/**
 * Definition of the memory table in the database.
 */
export const memoryTable = mysqlTable(
  'memories',
  {
    id: varchar('id', { length: 36 }).primaryKey().notNull(),
    type: varchar('type', { length: 50 }).notNull(),
    createdAt: numberTimestamp('createdAt')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    content: json('content').$type<Content>().notNull(),
    entityId: varchar('entityId', { length: 36 }),
    agentId: varchar('agentId', { length: 36 }),
    roomId: varchar('roomId', { length: 36 }),
    unique: boolean('unique').default(true).notNull(),
    metadata: json('metadata')
      .$type<MemoryMetadata>()
      .default(sql`('{}')`)
      .notNull(),
  },
  (table) => [
    index('idx_memories_type_room').on(table.type, table.roomId),
    foreignKey({
      name: 'fk_room',
      columns: [table.roomId],
      foreignColumns: [roomTable.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_memories_entityId',
      columns: [table.entityId],
      foreignColumns: [entityTable.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_agent',
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete('cascade'),
    // MySQL doesn't support JSON path indexing like PostgreSQL
    // so we'll need to use generated columns for these indexes
    index('idx_memories_metadata_type').on(table.type),
    index('idx_memories_document_id').on(table.id),
    index('idx_fragments_order').on(table.id),
    // MySQL doesn't support check constraints in the same way as PostgreSQL
    // We may need to enforce these constraints at the application level
  ]
);

// Inferred database model types from the memory table schema
export type SelectMemory = InferSelectModel<typeof memoryTable>;
export type InsertMemory = InferInsertModel<typeof memoryTable>;

// This import is added here to avoid circular dependency
import { embeddingTable } from './embedding';

// Define relations for the memory table
export const memoryRelations = relations(memoryTable, ({ one }) => ({
  embedding: one(embeddingTable, {
    fields: [memoryTable.id],
    references: [embeddingTable.memoryId],
  }),
}));

/**
 * Maps a Drizzle memory record to the core Memory type
 */
export function mapToMemory(memoryRow: SelectMemory): Memory {
  return {
    id: memoryRow.id as UUID,
    entityId: memoryRow.entityId as UUID,
    agentId: memoryRow.agentId as UUID | undefined,
    roomId: memoryRow.roomId as UUID,
    createdAt: memoryRow.createdAt,
    content: memoryRow.content,
    unique: memoryRow.unique,
    metadata:
      typeof memoryRow.metadata === 'object' && memoryRow.metadata !== null
        ? memoryRow.metadata
        : ({} as MemoryMetadata),
  };
}

/**
 * Maps a core Memory object to a Drizzle memory record for database operations
 */
export function mapToMemoryRow(memory: Partial<Memory>, tableName?: string): InsertMemory {
  const result: Partial<InsertMemory> = {};

  const contentToInsert =
    typeof memory.content === 'string' ? JSON.parse(memory.content) : memory.content;

  // Copy only properties that exist in the memory object
  if (memory.id !== undefined) result.id = memory.id;
  if (memory.createdAt !== undefined) result.createdAt = memory.createdAt;
  if (memory.content !== undefined) result.content = contentToInsert;
  if (memory.entityId !== undefined) result.entityId = memory.entityId;
  if (memory.agentId !== undefined) result.agentId = memory.agentId;
  if (memory.roomId !== undefined) result.roomId = memory.roomId;
  if (memory.unique !== undefined) result.unique = memory.unique;
  if (memory.metadata !== undefined) result.metadata = memory.metadata;

  // Set the memory type based on the table name parameter if it exists
  if (tableName) result.type = tableName;

  return result as InsertMemory;
}
