/**
 * Drizzle schema for `tasks` — the persistence backing for the runtime's
 * `Task` model (deferred/queued work items scoped to a room, world, entity,
 * and/or agent), with free-form `tags` and `metadata` for scheduler-specific
 * state.
 */
import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";

export const taskTable = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  roomId: uuid("room_id"),
  worldId: uuid("world_id"),
  entityId: uuid("entity_id"),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agentTable.id, { onDelete: "cascade" }),
  tags: text("tags").array().default(sql`'{}'::text[]`),
  metadata: jsonb("metadata").default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
