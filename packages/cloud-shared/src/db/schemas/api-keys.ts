import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
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
 * Stores API keys for programmatic access. Keys are hashed (SHA-256) for
 * lookup during auth, AND the plaintext is encrypted at rest under the
 * org's DEK (D-1) so a DB-only compromise cannot exfiltrate live keys.
 *
 * The plaintext is only ever returned on creation (one-time reveal),
 * decrypted in-memory immediately after insert.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    key_hash: text("key_hash").notNull().unique(),
    key_prefix: text("key_prefix").notNull(),
    // Encrypted plaintext columns (D-1). KMS envelope under org DEK,
    // AAD = "api_keys|<row_id>|key". base64-encoded.
    key_ciphertext: text("key_ciphertext"),
    key_nonce: text("key_nonce"),
    key_auth_tag: text("key_auth_tag"),
    key_kms_key_id: text("key_kms_key_id"),
    key_kms_key_version: integer("key_kms_key_version"),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rate_limit: integer("rate_limit").notNull().default(1000),
    is_active: boolean("is_active").notNull().default(true),
    usage_count: integer("usage_count").default(0).notNull(),
    expires_at: timestamp("expires_at"),
    last_used_at: timestamp("last_used_at"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    deleted_at: timestamp("deleted_at"),
  },
  (table) => ({
    key_hash_idx: uniqueIndex("api_keys_key_hash_idx").on(table.key_hash),
    key_prefix_idx: index("api_keys_key_prefix_idx").on(table.key_prefix),
    organization_idx: index("api_keys_organization_idx").on(table.organization_id),
    user_idx: index("api_keys_user_idx").on(table.user_id),
    deleted_at_idx: index("api_keys_deleted_at_idx").on(table.deleted_at),
  }),
);

// Type inference
export type ApiKey = InferSelectModel<typeof apiKeys>;
export type NewApiKey = InferInsertModel<typeof apiKeys>;
