/**
 * Drizzle schema for `participants` — join table linking an entity (and/or
 * agent) to a room, with a per-room `roomState` (e.g. muted/followed). Both
 * `entityId` and `roomId` cascade-delete via redundant FK declarations (index
 * + explicit `foreignKey()`), so removing an entity or room prunes its
 * participant rows automatically.
 */
import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
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
    membershipState: text("membership_state"),
    membershipSource: text("membership_source"),
    membershipObservedAt: timestamp("membership_observed_at", { withTimezone: true }),
    membershipExpiresAt: timestamp("membership_expires_at", { withTimezone: true }),
    membershipCursor: text("membership_cursor"),
    membershipGeneration: integer("membership_generation"),
  },
  (table) => [
    index("idx_participants_user").on(table.entityId),
    index("idx_participants_room").on(table.roomId),
    uniqueIndex("participants_agent_room_entity_unique").on(
      table.agentId,
      table.roomId,
      table.entityId
    ),
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
