import { sql } from "drizzle-orm";
import { pgTable, text, uuid, timestamp } from "drizzle-orm/pg-core";

export const newsTable = pgTable("latest_news", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  description: text("description").notNull(),
  link: text("link").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});