import { sql } from 'drizzle-orm';
import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Represents a table for storing owner data for RLS multi-tenant isolation.
 *
 * @type {Table}
 */
export const ownersTable = pgTable('owners', {
  id: uuid('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});
