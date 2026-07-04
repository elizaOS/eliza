/**
 * Attaches structured, typed data (`type` + freeform `data` JSON) to an
 * entity within a room/world context — e.g. profile fields, connector-
 * specific metadata, or other per-entity extensions that don't belong on the
 * core entity row. Cascade-deletes with its owning entity, agent, or room;
 * `worldId` and `sourceEntityId` are optional and also cascade when set.
 */
import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";
import { entityTable } from "./entity";
import { roomTable } from "./room";
import { worldTable } from "./world";

export const componentTable = pgTable("components", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`).notNull(),

  entityId: uuid("entity_id")
    .references(() => entityTable.id, { onDelete: "cascade" })
    .notNull(),
  agentId: uuid("agent_id")
    .references(() => agentTable.id, { onDelete: "cascade" })
    .notNull(),
  roomId: uuid("room_id")
    .references(() => roomTable.id, { onDelete: "cascade" })
    .notNull(),
  worldId: uuid("world_id").references(() => worldTable.id, {
    onDelete: "cascade",
  }),
  sourceEntityId: uuid("source_entity_id").references(() => entityTable.id, {
    onDelete: "cascade",
  }),

  type: text("type").notNull(),
  data: jsonb("data").default(sql`'{}'::jsonb`),

  createdAt: timestamp("created_at").default(sql`now()`).notNull(),
});
