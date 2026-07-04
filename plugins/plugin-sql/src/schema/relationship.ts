/**
 * Drizzle schema for `relationships` — a directed edge between two entities,
 * scoped to a single agent, carrying free-form `tags` and `metadata`. The
 * `unique_relationship` constraint enforces at most one row per
 * (source, target, agent) triple; direction matters, so A→B and B→A are
 * distinct rows.
 */
import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agentTable } from "./agent";
import { entityTable } from "./entity";

export const relationshipTable = pgTable(
  "relationships",
  {
    id: uuid("id").notNull().primaryKey().default(sql`gen_random_uuid()`),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    sourceEntityId: uuid("source_entity_id")
      .notNull()
      .references(() => entityTable.id, { onDelete: "cascade" }),
    targetEntityId: uuid("target_entity_id")
      .notNull()
      .references(() => entityTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    tags: text("tags").array(),
    metadata: jsonb("metadata"),
  },
  (table) => [
    index("idx_relationships_users").on(table.sourceEntityId, table.targetEntityId),
    unique("unique_relationship").on(table.sourceEntityId, table.targetEntityId, table.agentId),
    foreignKey({
      name: "fk_user_a",
      columns: [table.sourceEntityId],
      foreignColumns: [entityTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_user_b",
      columns: [table.targetEntityId],
      foreignColumns: [entityTable.id],
    }).onDelete("cascade"),
  ]
);
