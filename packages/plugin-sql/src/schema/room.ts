import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";
import { numberTimestamp } from "./types";
import { worldTable } from "./worldTable";

export const roomTable = pgTable("rooms", {
	id: uuid("id").notNull().primaryKey().default(sql`gen_random_uuid()`),
	agentId: uuid("agentId").references(() => agentTable.id, {
		onDelete: "cascade",
	}),
	source: text("source").notNull(),
	type: text("type").notNull(),
	serverId: text("serverId"),
	worldId: uuid("worldId").references(() => worldTable.id, {
		onDelete: "cascade",
	}),
	name: text("name"),
	metadata: jsonb("metadata"),
	channelId: text("channelId"),
	createdAt: numberTimestamp("createdAt").default(sql`now()`).notNull(),
});
