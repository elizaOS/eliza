import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * API keys table schema.
 *
 * Stores API keys for programmatic access. Keys are hashed for security
 * and can have expiration dates and usage limits.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    key: text("key").notNull().unique(),
    key_hash: text("key_hash").notNull().unique(),
    key_prefix: text("key_prefix").notNull(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permissions: jsonb("permissions").$type<string[]>().default([]).notNull(),
    rate_limit: integer("rate_limit").notNull().default(1000),
    is_active: boolean("is_active").notNull().default(true),
    usage_count: integer("usage_count").default(0).notNull(),
    expires_at: timestamp("expires_at"),
    last_used_at: timestamp("last_used_at"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    key_idx: index("api_keys_key_idx").on(table.key),
    key_hash_idx: uniqueIndex("api_keys_key_hash_idx").on(table.key_hash),
    key_prefix_idx: index("api_keys_key_prefix_idx").on(table.key_prefix),
    organization_idx: index("api_keys_organization_idx").on(table.organization_id),
    user_idx: index("api_keys_user_idx").on(table.user_id),
  }),
);

// Type inference
export type ApiKey = InferSelectModel<typeof apiKeys>;
export type NewApiKey = InferInsertModel<typeof apiKeys>;
