import {
	pgTable,
	uuid,
	text,
	index,
	foreignKey,
	unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { numberTimestamp } from "./types";
import { entityTable } from "./entity";
import { roomTable } from "./room";
import { agentTable } from "./agent";

/**
 * Defines the schema for the "participants" table in the database.
 * 
 * @type {import('knex').TableBuilder}
 */
export const participantTable = pgTable(
	"participants",
	{
		id: uuid("id").notNull().primaryKey().default(sql`gen_random_uuid()`),
		createdAt: numberTimestamp("createdAt").default(sql`now()`).notNull(),
		entityId: uuid("entityId").references(() => entityTable.id, {
			onDelete: "cascade",
		}),
		roomId: uuid("roomId").references(() => roomTable.id, {
			onDelete: "cascade",
		}),
		agentId: uuid("agentId").references(() => agentTable.id, {
			onDelete: "cascade",
		}),
		roomState: text("roomState"),
	},
	(table) => [
		// unique("participants_user_room_agent_unique").on(table.entityId, table.roomId, table.agentId),
		index("idx_participants_user").on(table.entityId),
		index("idx_participants_room").on(table.roomId),
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
