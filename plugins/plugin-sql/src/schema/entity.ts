/**
 * Drizzle table for entities — the participants (users, agents, personas) an
 * agent can hold memories and relationships about. Scoped to an owning agent
 * via a cascading `agent_id` foreign key, with a compound unique constraint on
 * (id, agentId) so other tables can enforce agent-scoped foreign keys against
 * this table. `metadata` carries free-form per-entity data; `names` tracks
 * known aliases.
 */
import type { Metadata } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";

export const entityTable = pgTable(
  "entities",
  {
    id: uuid("id").notNull().primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, {
        onDelete: "cascade",
      }),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    names: text("names").array().default(sql`'{}'::text[]`).notNull(),
    metadata: jsonb("metadata").$type<Metadata>().default(sql`'{}'::jsonb`).notNull(),
  },
  (table) => {
    return {
      idAgentIdUnique: unique("id_agent_id_unique").on(table.id, table.agentId),
    };
  }
);
