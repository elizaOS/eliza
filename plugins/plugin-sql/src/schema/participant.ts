/**
 * Drizzle schema for `participants` — join table linking an entity (and/or
 * agent) to a room, with a per-room `roomState` (e.g. muted/followed). Both
 * `entityId` and `roomId` cascade-delete via redundant FK declarations (index
 * + explicit `foreignKey()`), so removing an entity or room prunes its
 * participant rows automatically.
 */
import { sql } from "drizzle-orm";
import { foreignKey, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";
import { entityTable } from "./entity";
import { roomTable } from "./room";

export const participantTable = pgTable(
  "participants",
  {
    id: uuid("id").notNull().primaryKey().default(sql`gen_random_uuid()`),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    entityId: uuid("entity_id").references(() => entityTable.id, {
      onDelete: "cascade",
    }),
    roomId: uuid("room_id").references(() => roomTable.id, {
      onDelete: "cascade",
    }),
    agentId: uuid("agent_id").references(() => agentTable.id, {
      onDelete: "cascade",
    }),
    roomState: text("room_state"),
  },
  (table) => [
    index("idx_participants_user").on(table.entityId),
    index("idx_participants_room").on(table.roomId),
    foreignKey({
      name: "fk_room",
      columns: [table.roomId],
      foreignColumns: [roomTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_user",
      columns: [table.entityId],
      foreignColumns: [entityTable.id],
    }).onDelete("cascade"),
  ]
);
