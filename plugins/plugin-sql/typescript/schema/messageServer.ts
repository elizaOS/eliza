import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const messageServerTable = pgTable("message_servers", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { mode: "date" }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});
