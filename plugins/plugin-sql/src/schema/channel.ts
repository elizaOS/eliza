/**
 * A conversation channel (DM, group, or connector-sourced room) belonging to
 * a message server. `type` holds the `ChannelType` enum as text; `sourceType`
 * / `sourceId` track the originating connector when the channel is mirrored
 * from an external platform. Cascade-deletes when its message server is
 * removed. When RLS is enabled, `applyRls` adds a `server_id` column at
 * migration time for per-server row isolation (PostgreSQL only).
 */
import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { messageServerTable } from "./messageServer";

export const channelTable = pgTable("channels", {
  id: text("id").primaryKey(), // UUID stored as text
  messageServerId: uuid("message_server_id")
    .notNull()
    .references(() => messageServerTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(), // Store ChannelType enum values as text
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  topic: text("topic"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { mode: "date" }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});
