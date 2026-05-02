/**
 * Entity Settings Schema
 *
 * Stores per-user settings for multi-tenant runtime sharing.
 * These settings take highest priority in the getSetting() resolution chain,
 * allowing users to provide their own API keys, OAuth tokens, and configuration
 * while sharing the same agent runtime.
 *
 * @example
 * User brings their own OpenAI API key:
 * - user_id: "user-123"
 * - agent_id: null (applies to all agents)
 * - key: "OPENAI_API_KEY"
 * - encrypted_value: <encrypted "sk-user-key">
 *
 * @example
 * User has agent-specific Twitter credentials:
 * - user_id: "user-123"
 * - agent_id: "agent-456"
 * - key: "TWITTER_ACCESS_TOKEN"
 * - encrypted_value: <encrypted "oauth-token">
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Entity settings table for per-user runtime settings.
 *
 * Encryption follows the same pattern as secrets.ts:
 * - encrypted_value: AES-256-GCM encrypted setting value
 * - encryption_key_id: KMS key used to encrypt the DEK
 * - encrypted_dek: Data Encryption Key encrypted with KMS
 * - nonce: GCM nonce for this encryption
 * - auth_tag: GCM authentication tag
 */
export const entitySettings = pgTable(
  "entity_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * The user who owns this setting.
     * Required - every entity setting belongs to a user.
     */
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /**
     * Optional agent ID for agent-specific settings.
     * NULL = setting applies to all agents for this user.
     * Set = setting only applies when interacting with this specific agent.
     *
     * Resolution priority:
     * 1. Agent-specific setting (user_id + agent_id)
     * 2. Global user setting (user_id + agent_id IS NULL)
     * 3. Agent default settings
     */
    agent_id: uuid("agent_id"),

    /**
     * The setting key (e.g., "OPENAI_API_KEY", "TWITTER_ACCESS_TOKEN").
     * Matches keys used in runtime.getSetting(key).
     */
    key: text("key").notNull(),

    /**
     * AES-256-GCM encrypted setting value.
     * Decrypted at prefetch time, stored in request context.
     */
    encrypted_value: text("encrypted_value").notNull(),

    /**
     * KMS key ID used to encrypt the DEK.
     */
    encryption_key_id: text("encryption_key_id").notNull(),

    /**
     * Data Encryption Key, encrypted with the KMS key.
     */
    encrypted_dek: text("encrypted_dek").notNull(),

    /**
     * GCM nonce for this encryption.
     */
    nonce: text("nonce").notNull(),

    /**
     * GCM authentication tag.
     */
    auth_tag: text("auth_tag").notNull(),

    /**
     * Timestamp when this setting was created.
     */
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * Timestamp when this setting was last updated.
     */
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    /**
     * Unique constraint: one setting per user+agent+key combination.
     * Allows upsert pattern for setting updates.
     *
     * Note: PostgreSQL treats NULL as distinct in unique constraints,
     * so (user_id, NULL, "KEY") and (user_id, agent_id, "KEY") are separate.
     */
    unique_user_agent_key: uniqueIndex("entity_settings_user_agent_key_idx").on(
      table.user_id,
      table.agent_id,
      table.key,
    ),

    /**
     * Index for fast lookup of all settings for a user.
     * Used when prefetching entity settings.
     */
    user_idx: index("entity_settings_user_idx").on(table.user_id),

    /**
     * Composite index for agent-specific lookups.
     */
    user_agent_idx: index("entity_settings_user_agent_idx").on(table.user_id, table.agent_id),

    /**
     * Index for key lookups across users (for admin/audit purposes).
     */
    key_idx: index("entity_settings_key_idx").on(table.key),
  }),
);

/**
 * Entity setting record from database select.
 */
export type EntitySetting = InferSelectModel<typeof entitySettings>;

/**
 * Entity setting for database insert.
 */
export type NewEntitySetting = InferInsertModel<typeof entitySettings>;
