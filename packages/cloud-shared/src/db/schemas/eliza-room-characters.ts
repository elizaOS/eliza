import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { userCharacters } from "./user-characters";

/**
 * Eliza room characters table schema.
 *
 * Maps elizaOS rooms to user-created characters, allowing each conversation
 * room to use a different character.
 */
export const elizaRoomCharactersTable = pgTable("eliza_room_characters", {
  room_id: uuid("room_id").primaryKey(),
  character_id: uuid("character_id")
    .notNull()
    .references(() => userCharacters.id, { onDelete: "cascade" }),
  user_id: uuid("user_id").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export type ElizaRoomCharacter = typeof elizaRoomCharactersTable.$inferSelect;
export type NewElizaRoomCharacter = typeof elizaRoomCharactersTable.$inferInsert;
