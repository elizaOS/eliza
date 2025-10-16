import { sql } from 'drizzle-orm';
import { pgTable, text, integer, real, index, varchar, timestamp } from 'drizzle-orm/pg-core';

/**
 * Memory access logs (optional - for tracking and improving memory retrieval)
 */
export const memoryAccessLogs = pgTable(
  'memory_access_logs',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    agentId: varchar('agent_id', { length: 36 }).notNull(),
    memoryId: varchar('memory_id', { length: 36 }).notNull(),
    memoryType: text('memory_type').notNull(), // 'long_term' or 'session_summary'
    accessedAt: timestamp('accessed_at')
      .default(sql`now()`)
      .notNull(),
    roomId: varchar('room_id', { length: 36 }),
    relevanceScore: real('relevance_score'),
    wasUseful: integer('was_useful'), // 1 = useful, 0 = not useful, null = unknown
  },
  (table) => ({
    memoryIdx: index('memory_access_logs_memory_idx').on(table.memoryId),
    agentIdx: index('memory_access_logs_agent_idx').on(table.agentId),
    accessedAtIdx: index('memory_access_logs_accessed_at_idx').on(table.accessedAt),
  })
);
