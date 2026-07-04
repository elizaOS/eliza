/**
 * Drizzle schema for `worlds` — the top-level container an agent's rooms
 * belong to (e.g. one Discord/Telegram server), scoped to a single agent.
 */
import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";

export const worldTable = pgTable("worlds", {
  id: uuid("id").notNull().primaryKey().default(sql`gen_random_uuid()`),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agentTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  metadata: jsonb("metadata"),
  messageServerId: uuid("message_server_id"),
  createdAt: timestamp("created_at").default(sql`now()`).notNull(),
});
