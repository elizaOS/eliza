import { pgTable, uuid, jsonb, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { entityTable } from "./entity";
import { numberTimestamp } from "./types";
import { agentTable } from "./agent";
import { roomTable } from "./room";
import { worldTable } from "./worldTable";

/**
 * Definition of a table representing components in the database.
 * 
 * @type {Table}
 */
export const componentTable = pgTable("components", {
	id: uuid("id").primaryKey().defaultRandom(),
	entityId: uuid("entityId")
		.notNull()
		.references(() => entityTable.id, { onDelete: "cascade" }),
	agentId: uuid("agentId")
		.notNull()
		.references(() => agentTable.id, { onDelete: "cascade" }),
	roomId: uuid("roomId")
		.notNull()
		.references(() => roomTable.id, { onDelete: "cascade" }),
	worldId: uuid("worldId").references(() => worldTable.id, {
		onDelete: "cascade",
	}),
	sourceEntityId: uuid("sourceEntityId").references(() => entityTable.id, {
		onDelete: "cascade",
	}),
	type: text("type").notNull(),
	data: jsonb("data").default(sql`'{}'::jsonb`),
	createdAt: numberTimestamp("createdAt").default(sql`now()`).notNull(),
});
