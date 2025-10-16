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
 * Session summaries table
 * Stores condensed summaries of conversation sessions
 */
export const sessionSummaries = pgTable(
  'session_summaries',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    agentId: varchar('agent_id', { length: 36 }).notNull(),
    roomId: varchar('room_id', { length: 36 }).notNull(),
    entityId: varchar('entity_id', { length: 36 }),
    summary: text('summary').notNull(),
    messageCount: integer('message_count').notNull(),
    startTime: timestamp('start_time').notNull(),
    endTime: timestamp('end_time').notNull(),
    topics: jsonb('topics'),
    metadata: jsonb('metadata'),
    embedding: real('embedding').array(),
    createdAt: timestamp('created_at')
      .default(sql`now()`)
      .notNull(),
  },
  (table) => ({
    agentRoomIdx: index('session_summaries_agent_room_idx').on(table.agentId, table.roomId),
    entityIdx: index('session_summaries_entity_idx').on(table.entityId),
    startTimeIdx: index('session_summaries_start_time_idx').on(table.startTime),
  })
);
