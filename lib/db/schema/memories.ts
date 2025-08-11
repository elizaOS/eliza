import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";

export const memories = pgTable("memories", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  agentId: integer().notNull(),
  content: text().notNull(),
  createdAt: timestamp().defaultNow(),
  updatedAt: timestamp().defaultNow(),
});
