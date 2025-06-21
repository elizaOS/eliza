import { primaryKey } from 'drizzle-orm/pg-core';
import { getSchemaFactory, createLazyTableProxy } from './factory';
import { agentTable } from './agent';

/**
 * Lazy-loaded cache table definition.
 * This function returns the cache table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createCacheTable() {
  const factory = getSchemaFactory();

  // Get the table function from the factory
  const tableFn = factory.table;
  return tableFn(
    'cache',
    {
      key: factory.text('key').notNull(),
      agentId: factory
        .uuid('agent_id')
        .notNull()
        .references(() => agentTable.id, { onDelete: 'cascade' }),
      value: factory.json('value').notNull(),
      createdAt: factory
        .timestamp('created_at', { withTimezone: true })
        .default(factory.defaultTimestamp())
        .notNull(),
      expiresAt: factory.timestamp('expires_at', { withTimezone: true }),
    },
    (table) => {
      return {
        pk: primaryKey({ columns: [table.key, table.agentId] }),
      };
    }
  );
}

/**
 * Represents a table for caching data.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const cacheTable = createLazyTableProxy(createCacheTable);
