import { sql } from 'drizzle-orm';
import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Represents a table for storing server data for RLS multi-tenant isolation.
 * Each server represents one ElizaOS instance in a multi-tenant deployment.
 *
 * @type {Table}
 */
export const serverTable = pgTable('servers', {
  id: uuid('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});
