/**
 * Drizzle schema for `session_summaries` — rolling, embeddable summaries of a
 * room's conversation, produced incrementally as messages accumulate.
 * `lastMessageOffset` tracks how far the summarizer has read so later runs can
 * resume rather than resummarize the whole room; `embedding` lets summaries be
 * retrieved semantically alongside raw memories.
 */
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const sessionSummaries = pgTable(
  "session_summaries",
  {
    id: uuid("id").primaryKey().notNull(),
    agentId: uuid("agent_id").notNull(),
    roomId: uuid("room_id").notNull(),
    entityId: uuid("entity_id"),
    summary: text("summary").notNull(),
    messageCount: integer("message_count").notNull(),
    lastMessageOffset: integer("last_message_offset").default(0).notNull(),
    startTime: timestamp("start_time").notNull(),
    endTime: timestamp("end_time").notNull(),
    topics: jsonb("topics").$type<string[]>(),
    metadata: jsonb("metadata"),
    embedding: real("embedding").array(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
  },
  (table) => [
    index("session_summaries_agent_room_idx").on(table.agentId, table.roomId),
    index("session_summaries_entity_idx").on(table.entityId),
    index("session_summaries_start_time_idx").on(table.startTime),
  ]
);
