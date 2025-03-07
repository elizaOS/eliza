import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { numberTimestamp } from "./types";
import { agentTable } from "./agent";

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
