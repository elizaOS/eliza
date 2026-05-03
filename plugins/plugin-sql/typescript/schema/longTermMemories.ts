import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const longTermMemories = pgTable(
  "long_term_memories",
  {
    id: uuid("id").primaryKey().notNull(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    category: text("category").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata"),
    embedding: real("embedding").array(),
    confidence: real("confidence").default(1),
    source: text("source"),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
    lastAccessedAt: timestamp("last_accessed_at"),
    accessCount: integer("access_count").default(0),
  },
  (table) => [
    index("long_term_memories_agent_entity_idx").on(table.agentId, table.entityId),
    index("long_term_memories_category_idx").on(table.category),
    index("long_term_memories_confidence_idx").on(table.confidence),
    index("long_term_memories_created_at_idx").on(table.createdAt),
  ]
);
