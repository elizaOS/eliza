import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  jsonb,
  real,
  index,
  varchar,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Long-term memory storage table
 * Stores persistent facts about users across all conversations
 */
export const longTermMemories = pgTable(
  'long_term_memories',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    agentId: varchar('agent_id', { length: 36 }).notNull(),
    entityId: varchar('entity_id', { length: 36 }).notNull(),
    category: text('category').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata'),
    embedding: real('embedding').array(),
    confidence: real('confidence').default(1.0),
    source: text('source'),
    createdAt: timestamp('created_at')
      .default(sql`now()`)
      .notNull(),
    updatedAt: timestamp('updated_at')
      .default(sql`now()`)
      .notNull(),
    lastAccessedAt: timestamp('last_accessed_at'),
    accessCount: integer('access_count').default(0),
  },
  (table) => ({
    agentEntityIdx: index('long_term_memories_agent_entity_idx').on(table.agentId, table.entityId),
    categoryIdx: index('long_term_memories_category_idx').on(table.category),
    confidenceIdx: index('long_term_memories_confidence_idx').on(table.confidence),
    createdAtIdx: index('long_term_memories_created_at_idx').on(table.createdAt),
  })
);
