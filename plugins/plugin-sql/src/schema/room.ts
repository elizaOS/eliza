/**
 * Drizzle schema for `rooms` — a conversation surface (DM, channel, thread)
 * that entities and agents participate in. `worldId` has no FK constraint
 * because a room can be created before its world row exists.
 */
import type { Metadata } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";

export const roomTable = pgTable("rooms", {
  id: uuid("id").notNull().primaryKey().default(sql`gen_random_uuid()`),
  agentId: uuid("agent_id").references(() => agentTable.id, {
    onDelete: "cascade",
  }),
  source: text("source").notNull(),
  type: text("type").notNull(),
  messageServerId: uuid("message_server_id"),
  worldId: uuid("world_id"),
  name: text("name"),
  metadata: jsonb("metadata").$type<Metadata>(),
  channelId: text("channel_id"),
  createdAt: timestamp("created_at").default(sql`now()`).notNull(),
});
