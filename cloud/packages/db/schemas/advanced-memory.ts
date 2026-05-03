import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

export const longTermMemories = pgTable(
  "long_term_memories",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agent_id", { length: 36 }).notNull(),
    entityId: varchar("entity_id", { length: 36 }).notNull(),
    category: text("category").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata"),
    embedding: real("embedding").array(),
    embedding384: vector("embedding_384", { dimensions: 384 }),
    embedding1536: vector("embedding_1536", { dimensions: 1536 }),
    confidence: real("confidence").default(1),
    source: text("source"),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
    lastAccessedAt: timestamp("last_accessed_at"),
    accessCount: integer("access_count").default(0),
  },
  (table) => ({
    agentEntityIdx: index("long_term_memories_agent_entity_idx").on(table.agentId, table.entityId),
    categoryIdx: index("long_term_memories_category_idx").on(table.category),
    confidenceIdx: index("long_term_memories_confidence_idx").on(table.confidence),
    createdAtIdx: index("long_term_memories_created_at_idx").on(table.createdAt),
  }),
);

export const sessionSummaries = pgTable(
  "session_summaries",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agent_id", { length: 36 }).notNull(),
    roomId: varchar("room_id", { length: 36 }).notNull(),
    entityId: varchar("entity_id", { length: 36 }),
    summary: text("summary").notNull(),
    messageCount: integer("message_count").notNull(),
    lastMessageOffset: integer("last_message_offset").notNull().default(0),
    startTime: timestamp("start_time").notNull(),
    endTime: timestamp("end_time").notNull(),
    topics: jsonb("topics"),
    metadata: jsonb("metadata"),
    embedding: real("embedding").array(),
    embedding384: vector("embedding_384", { dimensions: 384 }),
    embedding1536: vector("embedding_1536", { dimensions: 1536 }),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
  },
  (table) => ({
    agentRoomIdx: index("session_summaries_agent_room_idx").on(table.agentId, table.roomId),
    entityIdx: index("session_summaries_entity_idx").on(table.entityId),
    startTimeIdx: index("session_summaries_start_time_idx").on(table.startTime),
  }),
);

export const memoryAccessLogs = pgTable(
  "memory_access_logs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agent_id", { length: 36 }).notNull(),
    memoryId: varchar("memory_id", { length: 36 }).notNull(),
    memoryType: text("memory_type").notNull(),
    accessedAt: timestamp("accessed_at").default(sql`now()`).notNull(),
    roomId: varchar("room_id", { length: 36 }),
    relevanceScore: real("relevance_score"),
    wasUseful: integer("was_useful"),
  },
  (table) => ({
    memoryIdx: index("memory_access_logs_memory_idx").on(table.memoryId),
    agentIdx: index("memory_access_logs_agent_idx").on(table.agentId),
    accessedAtIdx: index("memory_access_logs_accessed_at_idx").on(table.accessedAt),
  }),
);
