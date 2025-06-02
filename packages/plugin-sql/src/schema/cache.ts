import { sql } from 'drizzle-orm';
import { getSchemaFactory } from './factory';
import { agentTable } from './agent';
import { numberTimestamp } from './types';
import { unique as pgUnique } from 'drizzle-orm/pg-core';
import { uniqueIndex as sqliteUniqueIndex } from 'drizzle-orm/sqlite-core';

const factory = getSchemaFactory();

/**
 * Represents a PostgreSQL table for caching data.
 *
 * @type {pgTable}
 */
export const cacheTable = (factory.table as any)(
  'cache',
  {
    id: factory
      .uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    key: factory.text('key').notNull(),
    agentId: factory
      .uuid('agentId')
      .notNull()
      .references(() => agentTable.id, { onDelete: 'cascade' }),
    value: factory.json('value').notNull(),
    createdAt: numberTimestamp('createdAt').default(factory.defaultTimestamp()).notNull(),
    expiresAt: numberTimestamp('expiresAt'),
  },
  (table: any) => {
    if (factory.dbType === 'postgres') {
      return [pgUnique('cache_key_agent_unique_pg_idx').on(table.key, table.agentId)];
    } else {
      return [sqliteUniqueIndex('sqlite_cache_key_agent_unique_idx').on(table.key, table.agentId)];
    }
  }
);
