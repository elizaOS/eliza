import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const taskTable = pgTable("tasks", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: text("name").notNull(),
	description: text("description").notNull(),
	roomId: uuid("room_id"),
	worldId: uuid("world_id"),
	agentId: uuid("agent_id").notNull(),
	tags: text("tags").array(),
	metadata: jsonb("metadata"),
	createdAt: timestamp("created_at").defaultNow(),
	updatedAt: timestamp("updated_at").defaultNow(),
});
