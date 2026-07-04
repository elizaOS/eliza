/**
 * Drizzle schema for `servers` — one row per elizaOS instance in a
 * multi-tenant deployment; its `id` is the RLS server UUID used to scope
 * row-level-security policies across the rest of the schema.
 */
import { sql } from "drizzle-orm";
import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

export const serverTable = pgTable("servers", {
  id: uuid("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
});
