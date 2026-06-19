import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Organization Encryption Keys table schema.
 *
 * Stores wrapped Data Encryption Keys (DEKs) for per-organization field encryption.
 * Each organization has one DEK that is wrapped (encrypted) with the master key.
 *
 * Key hierarchy:
 * - Master Key (SECRETS_MASTER_KEY env var) wraps ->
 * - Organization DEK (stored here, encrypted) encrypts ->
 * - Sensitive fields (user_database_uri, api_keys, etc.)
 */
export const organizationEncryptionKeys = pgTable(
  "organization_encryption_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** DEK encrypted with master key. Format: <nonce>:<authTag>:<encryptedDek> (all base64) */
    encrypted_dek: text("encrypted_dek").notNull(),
    /** Incremented on key rotation */
    key_version: integer("key_version").notNull().default(1),
    /** Encryption algorithm used */
    algorithm: text("algorithm").notNull().default("aes-256-gcm"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    /** When the key was last rotated */
    rotated_at: timestamp("rotated_at"),
  },
  (table) => ({
    orgUnique: unique("organization_encryption_keys_org_unique").on(table.organization_id),
    orgIdx: index("org_encryption_keys_org_idx").on(table.organization_id),
  }),
);

// Type inference
export type OrganizationEncryptionKey = InferSelectModel<typeof organizationEncryptionKeys>;
export type NewOrganizationEncryptionKey = InferInsertModel<typeof organizationEncryptionKeys>;
