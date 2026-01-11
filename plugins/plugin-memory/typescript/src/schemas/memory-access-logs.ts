import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * Memory access logs table
 * Tracks access patterns for memory optimization
 */
export const memoryAccessLogs = pgTable(
  "memory_access_logs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    memoryId: varchar("memory_id", { length: 36 }).notNull(),
    memoryType: text("memory_type").notNull(), // 'long_term' or 'session'
    agentId: varchar("agent_id", { length: 36 }).notNull(),
    accessType: text("access_type").notNull(), // 'read', 'write', 'update', 'delete'
    accessedAt: timestamp("accessed_at").default(sql`now()`).notNull(),
  },
  (table) => ({
    memoryIdIdx: index("memory_access_logs_memory_id_idx").on(table.memoryId),
    agentIdIdx: index("memory_access_logs_agent_id_idx").on(table.agentId),
    accessedAtIdx: index("memory_access_logs_accessed_at_idx").on(table.accessedAt),
  })
);
