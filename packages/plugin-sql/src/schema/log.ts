import { pgTable, uuid, text, jsonb, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { numberTimestamp } from "./types";
import { entityTable } from "./entity";
import { roomTable } from "./room";

export const logTable = pgTable(
	"logs",
	{
		id: uuid("id").defaultRandom().notNull(),
		createdAt: numberTimestamp("createdAt").default(sql`now()`).notNull(),
		entityId: uuid("entityId")
			.notNull()
			.references(() => entityTable.id),
		body: jsonb("body").notNull(),
		type: text("type").notNull(),
		roomId: uuid("roomId")
			.notNull()
			.references(() => roomTable.id),
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
