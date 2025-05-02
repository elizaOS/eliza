import { sql } from 'drizzle-orm';
import { json, mysqlTable, unique, varchar } from 'drizzle-orm/mysql-core';
import { agentTable } from './agent';
import { numberTimestamp } from './types';
import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type { UUID } from '@elizaos/core';

/**
 * Represents a PostgreSQL table for caching data.
 *
 * @type {pgTable}
 */
export const cacheTable = mysqlTable(
  'cache',
  {
    id: varchar('id', { length: 36 })
      .notNull()
      .primaryKey()
      .default(sql`(UUID())`),
    key: varchar('key', { length: 255 }).notNull(),
    agentId: varchar('agentId', { length: 36 })
      .notNull()
      .references(() => agentTable.id, { onDelete: 'cascade' }),
    value: json('value').notNull(),
    createdAt: numberTimestamp('createdAt')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    expiresAt: numberTimestamp('expiresAt'),
  },
  (table) => [unique('cache_key_agent_unique').on(table.key, table.agentId)]
);

/**
 * Type definitions for the cache table
 */
export type SelectCache = InferSelectModel<typeof cacheTable>;
export type InsertCache = InferInsertModel<typeof cacheTable>;

/**
 * Interface representing a cache entry in the application
 */
export interface Cache<T = any> {
  id: UUID;
  key: string;
  agentId: UUID;
  value: T;
  createdAt: number;
  expiresAt?: number;
}

/**
 * Maps a SelectCache object to a Cache object
 */
export function mapToCache<T = any>(cacheRow: SelectCache): Cache<T> {
  return {
    id: cacheRow.id as UUID,
    key: cacheRow.key,
    agentId: cacheRow.agentId as UUID,
    value: cacheRow.value as T,
    createdAt: cacheRow.createdAt,
    expiresAt: cacheRow.expiresAt ?? undefined,
  };
}

/**
 * Maps a Cache object to a InsertCache object
 */
export function mapToCacheRow<T = any>(cache: Partial<Cache<T>>): InsertCache {
  const result: Partial<InsertCache> = {};

  if (cache.id !== undefined) result.id = cache.id;
  if (cache.key !== undefined) result.key = cache.key;
  if (cache.agentId !== undefined) result.agentId = cache.agentId;
  if (cache.value !== undefined) result.value = cache.value;
  if (cache.createdAt !== undefined) result.createdAt = cache.createdAt;
  if (cache.expiresAt !== undefined) result.expiresAt = cache.expiresAt;

  return result as InsertCache;
}
