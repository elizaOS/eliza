import { sql } from 'drizzle-orm';
import { json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import { World, UUID } from '@elizaos/core';
import { agentTable } from './agent';
import { roomTable } from './room';
import { numberTimestamp } from './types';
import { relations } from 'drizzle-orm';

/**
 * Represents a table schema for worlds in the database.
 *
 * @type {MysqlTable}
 */
export const worldTable = mysqlTable('worlds', {
  id: varchar('id', { length: 36 })
    .notNull()
    .primaryKey()
    .default(sql`(UUID())`),
  agentId: varchar('agentId', { length: 36 })
    .notNull()
    .references(() => agentTable.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  metadata: json('metadata')
    .$type<Record<string, unknown>>()
    .default(sql`('{}')`),
  serverId: varchar('serverId', { length: 255 }).notNull(),
  createdAt: numberTimestamp('createdAt')
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

// Inferred database model types from the world table schema
export type SelectWorld = InferSelectModel<typeof worldTable>;
export type InsertWorld = InferInsertModel<typeof worldTable>;

// Define relations for the world table
export const worldRelations = relations(worldTable, ({ many }) => ({
  rooms: many(roomTable),
}));

/**
 * Maps a Drizzle world record to the core World type
 */
export function mapToWorld(worldRow: SelectWorld): World {
  return {
    id: worldRow.id as UUID,
    agentId: worldRow.agentId as UUID,
    name: worldRow.name,
    serverId: worldRow.serverId,
    metadata:
      typeof worldRow.metadata === 'object' && worldRow.metadata !== null
        ? (worldRow.metadata as Record<string, unknown>)
        : {},
  } as World;
}

/**
 * Maps a core World object to a Drizzle world record for database operations
 */
export function mapToWorldRow(world: Partial<World>): InsertWorld {
  const result: Partial<InsertWorld> = {};

  // Copy only properties that exist in the world object
  if (world.id !== undefined) result.id = world.id;
  if (world.agentId !== undefined) result.agentId = world.agentId;
  if (world.name !== undefined) result.name = world.name;
  if (world.serverId !== undefined) result.serverId = world.serverId;
  if (world.metadata !== undefined) result.metadata = world.metadata;

  return result as InsertWorld;
}
