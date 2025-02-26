import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";
import { numberTimestamp } from "./types";

export const entityTable = pgTable("entities", {
    id: uuid("id").notNull().primaryKey(),
    agentId: uuid("agentId").notNull().references(() => agentTable.id),
    createdAt: numberTimestamp("createdAt")
        .default(sql`now()`)
        .notNull(),
    names: text("names").array().default(sql`'{}'::text[]`),
    metadata: jsonb("metadata").default(sql`'{}'::jsonb`),
}, (table) => {
    return {
        idAgentIdUnique: unique("id_agent_id_unique").on(table.id, table.agentId)
    }
});
