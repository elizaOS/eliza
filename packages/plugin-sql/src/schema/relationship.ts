import { sql } from 'drizzle-orm';
import { foreignKey, index, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { agentTable } from './agent';
import { entityTable } from './entity';
import { numberTimestamp } from './types';
import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type { Relationship, UUID } from '@elizaos/core';

/**
 * Defines the relationshipTable containing information about relationships between entities and agents.
 */
export const relationshipTable = pgTable(
  'relationships',
  {
    id: uuid('id')
      .notNull()
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    createdAt: numberTimestamp('createdAt')
      .default(sql`now()`)
      .notNull(),
    sourceEntityId: uuid('sourceEntityId')
      .notNull()
      .references(() => entityTable.id, { onDelete: 'cascade' }),
    targetEntityId: uuid('targetEntityId')
      .notNull()
      .references(() => entityTable.id, { onDelete: 'cascade' }),
    agentId: uuid('agentId')
      .notNull()
      .references(() => agentTable.id, { onDelete: 'cascade' }),
    tags: text('tags').array(),
    metadata: jsonb('metadata'),
  },
  (table) => [
    index('idx_relationships_users').on(table.sourceEntityId, table.targetEntityId),
    unique('unique_relationship').on(table.sourceEntityId, table.targetEntityId, table.agentId),
    foreignKey({
      name: 'fk_user_a',
      columns: [table.sourceEntityId],
      foreignColumns: [entityTable.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_user_b',
      columns: [table.targetEntityId],
      foreignColumns: [entityTable.id],
    }).onDelete('cascade'),
  ]
);

// Inferred database model types from the relationship table schema
export type SelectRelationship = InferSelectModel<typeof relationshipTable>;
export type InsertRelationship = InferInsertModel<typeof relationshipTable>;

/**
 * Maps a Drizzle Relationship from the database to the Core Relationship type
 * @param drizzleRelationship The relationship data from the database
 * @returns A properly typed Relationship object for the core system
 */
export function mapToRelationship(drizzleRelationship: SelectRelationship): Relationship {
  return {
    id: drizzleRelationship.id as UUID,
    sourceEntityId: drizzleRelationship.sourceEntityId as UUID,
    targetEntityId: drizzleRelationship.targetEntityId as UUID,
    agentId: drizzleRelationship.agentId as UUID,
    tags: drizzleRelationship.tags || [],
    metadata: drizzleRelationship.metadata || {},
    createdAt: drizzleRelationship.createdAt?.toString(),
  };
}

/**
 * Maps a Core Relationship (or partial relationship) to a Drizzle database relationship for storage
 * @param relationship The core relationship to map to database format
 * @returns A properly typed object for database operations
 */
export function mapToRelationshipRow(relationship: Partial<Relationship>): InsertRelationship {
  const result: Partial<InsertRelationship> = {};

  // Only copy properties that exist in the relationship
  if (relationship.id !== undefined) result.id = relationship.id;
  if (relationship.sourceEntityId !== undefined)
    result.sourceEntityId = relationship.sourceEntityId;
  if (relationship.targetEntityId !== undefined)
    result.targetEntityId = relationship.targetEntityId;
  if (relationship.agentId !== undefined) result.agentId = relationship.agentId;
  if (relationship.tags !== undefined) result.tags = relationship.tags;
  if (relationship.metadata !== undefined) result.metadata = relationship.metadata;
  // createdAt is managed by the database with default SQL value

  return result as InsertRelationship;
}
