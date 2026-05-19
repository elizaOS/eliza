import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const memoryAccessLogs = pgTable(
  "memory_access_logs",
  {
    id: uuid("id").primaryKey().notNull(),
    memoryId: uuid("memory_id").notNull(),
    memoryType: text("memory_type").notNull(),
    agentId: uuid("agent_id").notNull(),
    accessType: text("access_type").notNull(),
    accessedAt: timestamp("accessed_at").default(sql`now()`).notNull(),
  },
  (table) => [
    index("memory_access_logs_memory_id_idx").on(table.memoryId),
    index("memory_access_logs_agent_id_idx").on(table.agentId),
    index("memory_access_logs_accessed_at_idx").on(table.accessedAt),
  ]
);
