import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";
import { numberTimestamp } from "./types";

/**
 * Represents a table schema for worlds in the database.
 *
 * @type {PgTable}
 */

export const worldTable = pgTable("worlds", {
	id: uuid("id").notNull().primaryKey().default(sql`gen_random_uuid()`),
	agentId: uuid("agentId")
		.notNull()
		.references(() => agentTable.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	metadata: jsonb("metadata"),
	serverId: text("serverId").notNull(),
	createdAt: numberTimestamp("createdAt").default(sql`now()`).notNull(),
});
