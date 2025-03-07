import {
	boolean,
	jsonb,
	pgTable,
	text,
	uuid,
	unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { numberTimestamp } from "./types";
import type { MessageExample } from "@elizaos/core";

export const agentTable = pgTable(
	"agents",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		createdAt: numberTimestamp("createdAt").default(sql`now()`).notNull(),

		updatedAt: numberTimestamp("updatedAt").default(sql`now()`).notNull(),

		enabled: boolean("enabled").default(true).notNull(),

		// Character
		name: text("name"),
		username: text("username"),
		system: text("system"),
		bio: jsonb("bio").$type<string | string[]>().notNull(),
		messageExamples: jsonb("message_examples")
			.$type<MessageExample[][]>()
			.default(sql`'[]'::jsonb`),
		postExamples: jsonb("post_examples")
			.$type<string[]>()
			.default(sql`'[]'::jsonb`),
		topics: jsonb("topics").$type<string[]>().default(sql`'[]'::jsonb`),
		adjectives: jsonb("adjectives").$type<string[]>().default(sql`'[]'::jsonb`),
		knowledge: jsonb("knowledge")
			.$type<(string | { path: string; shared?: boolean })[]>()
			.default(sql`'[]'::jsonb`),
		plugins: jsonb("plugins").$type<string[]>().default(sql`'[]'::jsonb`),
		settings: jsonb("settings")
			.$type<{
				secrets?: { [key: string]: string | boolean | number };
				[key: string]: unknown;
			}>()
			.default(sql`'{}'::jsonb`),
		style: jsonb("style")
			.$type<{
				all?: string[];
				chat?: string[];
				post?: string[];
			}>()
			.default(sql`'{}'::jsonb`),
	},
	(table) => {
		return {
			nameUnique: unique("name_unique").on(table.name),
		};
	},
);
