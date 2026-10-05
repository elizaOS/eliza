/** Exact pre-observation identity table from ce2d22df98a, for additive upgrade tests. */
import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agentTable } from "../../../schema/agent";
import { entityTable } from "../../../schema/entity";

export const legacyIdentityTable = pgTable(
  "entity_identities",
  {
    id: uuid("id").notNull().primaryKey().default(sql`gen_random_uuid()`),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entityTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    handle: text("handle").notNull(),
    verified: boolean("verified").notNull().default(false),
    confidence: real("confidence").notNull().default(0),
    source: text("source"),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().default(sql`now()`),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().default(sql`now()`),
    evidenceMessageIds: jsonb("evidence_message_ids").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    index("idx_entity_identities_entity").on(table.entityId),
    index("idx_entity_identities_platform_handle").on(table.platform, table.handle),
    unique("unique_entity_identity").on(
      table.entityId,
      table.platform,
      table.handle,
      table.agentId
    ),
    foreignKey({
      name: "fk_entity_identities_entity",
      columns: [table.entityId],
      foreignColumns: [entityTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_entity_identities_agent",
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete("cascade"),
  ]
);
