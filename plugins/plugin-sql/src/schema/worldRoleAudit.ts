/**
 * Durable authority ledger for committed world-role mutations. Actor, target,
 * room, and world identifiers are intentionally retained as scalar evidence:
 * deleting operational entities, rooms, or worlds must not erase who changed
 * authorization, where it originated, or what the transition was.
 */
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";

export const worldRoleAuditTable = pgTable(
  "world_role_audit",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`).notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    worldId: uuid("world_id").notNull(),
    actorEntityId: uuid("actor_entity_id").notNull(),
    targetEntityId: uuid("target_entity_id").notNull(),
    roomId: uuid("room_id").notNull(),
    previousRole: text("previous_role").notNull(),
    newRole: text("new_role").notNull(),
    grantSource: text("grant_source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    index("world_role_audit_agent_world_idx").on(table.agentId, table.worldId, table.createdAt),
    index("world_role_audit_target_idx").on(table.agentId, table.targetEntityId, table.createdAt),
  ]
);
