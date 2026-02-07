import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { Metadata } from '@elizaos/core';
import { agentTable } from './agent';

/**
 * Represents an entity table in the database.
 * Includes columns for id, agentId, createdAt, names, and metadata.
 */
export const entityTable = pgTable(
  'entities',
  {
    id: uuid('id').notNull().primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agentTable.id, {
        onDelete: 'cascade',
      }),
    createdAt: timestamp('created_at')
      .default(sql`now()`)
      .notNull(),
    names: text('names')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    metadata: jsonb('metadata')
      .$type<Metadata>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
  },
  (table) => {
    return {
      idAgentIdUnique: unique('id_agent_id_unique').on(table.id, table.agentId),
    };
  }
);
