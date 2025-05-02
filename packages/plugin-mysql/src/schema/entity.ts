import { sql } from 'drizzle-orm';
import { json, mysqlTable, unique, varchar } from 'drizzle-orm/mysql-core';
import { agentTable } from './agent';
import { numberTimestamp } from './types';
import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type { Entity, UUID } from '@elizaos/core';

/**
 * Represents an entity table in the database.
 * Includes columns for id, agentId, createdAt, names, and metadata.
 */
export const entityTable = mysqlTable(
  'entities',
  {
    id: varchar('id', { length: 36 }).notNull().primaryKey(),
    agentId: varchar('agentId', { length: 36 })
      .notNull()
      .references(() => agentTable.id, {
        onDelete: 'cascade',
      }),
    createdAt: numberTimestamp('createdAt')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    // MySQL doesn't support native arrays, use JSON instead
    names: json('names')
      .$type<string[]>()
      .default(sql`('[]')`),
    metadata: json('metadata')
      .$type<Record<string, any>>()
      .default(sql`('{}')`),
  },
  (table) => [unique('id_agent_id_unique').on(table.id, table.agentId)]
);

// Inferred database model types from the entity table schema
export type SelectEntity = InferSelectModel<typeof entityTable>;
export type InsertEntity = InferInsertModel<typeof entityTable>;

/**
 * Maps a database entity model to the Core Entity type
 * @param entityRow The entity data from the database
 * @returns A properly typed Entity object for the core system
 */
export function mapToEntity(entityRow: SelectEntity): Entity {
  return {
    id: entityRow.id as UUID,
    names: Array.isArray(entityRow.names) ? entityRow.names : [],
    metadata:
      typeof entityRow.metadata === 'object' && entityRow.metadata !== null
        ? entityRow.metadata
        : {},
    agentId: entityRow.agentId as UUID,
  };
}

/**
 * Maps a Core Entity (or partial entity) to a database entity model for storage
 * @param entity The core entity to map to database format
 * @returns A properly typed object for database operations
 */
export function mapToEntityRow(entity: Partial<Entity>): InsertEntity {
  const result: Partial<InsertEntity> = {};

  // Only copy properties that exist in the entity
  if (entity.id !== undefined) result.id = entity.id;
  if (entity.names !== undefined) result.names = entity.names;
  if (entity.metadata !== undefined) result.metadata = entity.metadata;
  if (entity.agentId !== undefined) result.agentId = entity.agentId;

  return result as InsertEntity;
}
