import { sql } from 'drizzle-orm';
import { getSchemaFactory } from './factory';
import { agentTable } from './agent';
import { numberTimestamp } from './types';
import { unique as pgUnique } from 'drizzle-orm/pg-core';
import { uniqueIndex as sqliteUniqueIndex } from 'drizzle-orm/sqlite-core';

const factory = getSchemaFactory();

/**
 * Represents an entity table in the database.
 * Includes columns for id, agentId, createdAt, names, and metadata.
 */
export const entityTable = (factory.table as any)(
  'entities',
  {
    id: factory
      .uuid('id')
      .notNull()
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: factory
      .uuid('agentId')
      .notNull()
      .references(() => agentTable.id, {
        onDelete: 'cascade',
      }),
    createdAt: numberTimestamp('createdAt').default(factory.defaultTimestamp()).notNull(),
    names: factory
      .textArray('names')
      .default(sql`'[]'`)
      .notNull(),
    metadata: factory
      .json('metadata')
      .default(sql`'{}'`)
      .notNull(),
  },
  (table) => {
    if (factory.dbType === 'postgres') {
      return { idAgentIdUnique: pgUnique('id_agent_id_unique_pg_idx').on(table.id, table.agentId) };
    } else {
      return {
        idAgentIdUniqueSqlite: sqliteUniqueIndex('sqlite_entity_id_agent_id_unique_idx').on(
          table.id,
          table.agentId
        ),
      };
    }
  }
);
