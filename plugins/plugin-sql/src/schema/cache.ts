/**
 * Generic key/value cache table shared across plugins and runtime subsystems,
 * scoped per agent. Values are arbitrary JSON; `expiresAt` is optional and
 * left to callers to enforce (no background eviction job here).
 *
 * Primary key is the composite `(key, agentId)`, so the same key string can
 * coexist across agents without collision. Rows cascade-delete when the
 * owning agent is removed.
 */
import { sql } from "drizzle-orm";
import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";

export const cacheTable = pgTable(
  "cache",
  {
    key: text("key").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    value: jsonb("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.key, table.agentId] })]
);
