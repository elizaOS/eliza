import { pgTable, uuid, text, jsonb, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { numberTimestamp } from "./types";
import { entityTable } from "./entity";
import { roomTable } from "./room";
import { agentTable } from "./agent";

/**
 * Represents a table in the database for storing goals.
 *
 * @type {Table}
 */
export const goalTable = pgTable(
	"goals",
	{
		id: uuid("id").notNull().primaryKey().default(sql`gen_random_uuid()`),
		createdAt: numberTimestamp("createdAt").default(sql`now()`).notNull(),
		entityId: uuid("entityId").references(() => entityTable.id, {
			onDelete: "cascade",
		}),
		agentId: uuid("agentId").references(() => agentTable.id, {
			onDelete: "cascade",
		}),
		name: text("name"),
		status: text("status"),
		description: text("description"),
		roomId: uuid("roomId").references(() => roomTable.id, {
			onDelete: "cascade",
		}),
		objectives: jsonb("objectives").default("[]").notNull(),
	},
	(table) => [
		foreignKey({
			name: "fk_room",
			columns: [table.roomId],
			foreignColumns: [roomTable.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "fk_user",
			columns: [table.entityId],
			foreignColumns: [entityTable.id],
		}).onDelete("cascade"),
	],
);
