import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Users table schema (core).
 *
 * Stores essential user account information and identity fields.
 *
 * NOTE: Identity fields are kept here because the auth system (ElizaAppUserService,
 * Discord/Telegram auth routes, session management) is deeply coupled to having
 * these fields directly on the User type. The user_identities table serves as a
 * read-optimized projection for analytics/metrics queries.
 *
 * Preferences (nickname, work_function, notification settings) → user_preferences table
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // User profile (core)
    email: text("email").unique(),
    email_verified: boolean("email_verified").default(false),
    wallet_address: text("wallet_address").unique(),
    wallet_chain_type: text("wallet_chain_type"),
    wallet_verified: boolean("wallet_verified").default(false).notNull(),
    name: text("name"),
    avatar: text("avatar"),

    // Organization
    organization_id: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    role: text("role").notNull().default("member"),

    // External identities (kept here for auth system compatibility)
    steward_user_id: text("steward_user_id").notNull().unique(),
    telegram_id: text("telegram_id").unique(),
    telegram_username: text("telegram_username"),
    telegram_first_name: text("telegram_first_name"),
    telegram_photo_url: text("telegram_photo_url"),
    discord_id: text("discord_id").unique(),
    discord_username: text("discord_username"),
    discord_global_name: text("discord_global_name"),
    discord_avatar_url: text("discord_avatar_url"),
    whatsapp_id: text("whatsapp_id").unique(),
    whatsapp_name: text("whatsapp_name"),
    phone_number: text("phone_number").unique(),
    phone_verified: boolean("phone_verified").default(false),

    // Anonymous user support
    is_anonymous: boolean("is_anonymous").default(false).notNull(),
    anonymous_session_id: text("anonymous_session_id"),
    expires_at: timestamp("expires_at"),

    // User preferences (kept for user API route & settings UI)
    nickname: text("nickname"),
    work_function: text("work_function"),
    preferences: text("preferences"),
    email_notifications: boolean("email_notifications").default(true),
    response_notifications: boolean("response_notifications").default(true),

    is_active: boolean("is_active").default(true).notNull(),

    // Field-level encryption columns (D-3). Each PII column has its own
    // ciphertext/nonce/auth_tag + key id/version. AAD = "users|<id>|<column>".
    // Plaintext columns above are kept nullable during the encryption rollout
    // and will be dropped in a follow-up migration once all repositories read
    // from the encrypted columns.
    email_ciphertext: text("email_ciphertext"),
    email_nonce: text("email_nonce"),
    email_auth_tag: text("email_auth_tag"),
    email_kms_key_id: text("email_kms_key_id"),
    email_kms_key_version: integer("email_kms_key_version"),
    // Deterministic HMAC of normalized (trim+lowercase) email for equality lookup.
    email_blind_index: text("email_blind_index"),

    phone_ciphertext: text("phone_ciphertext"),
    phone_nonce: text("phone_nonce"),
    phone_auth_tag: text("phone_auth_tag"),
    phone_kms_key_id: text("phone_kms_key_id"),
    phone_kms_key_version: integer("phone_kms_key_version"),
    phone_blind_index: text("phone_blind_index"),

    wallet_address_ciphertext: text("wallet_address_ciphertext"),
    wallet_address_nonce: text("wallet_address_nonce"),
    wallet_address_auth_tag: text("wallet_address_auth_tag"),
    wallet_address_kms_key_id: text("wallet_address_kms_key_id"),
    wallet_address_kms_key_version: integer("wallet_address_kms_key_version"),
    wallet_address_blind_index: text("wallet_address_blind_index"),

    telegram_id_ciphertext: text("telegram_id_ciphertext"),
    telegram_id_nonce: text("telegram_id_nonce"),
    telegram_id_auth_tag: text("telegram_id_auth_tag"),
    telegram_id_kms_key_id: text("telegram_id_kms_key_id"),
    telegram_id_kms_key_version: integer("telegram_id_kms_key_version"),

    discord_id_ciphertext: text("discord_id_ciphertext"),
    discord_id_nonce: text("discord_id_nonce"),
    discord_id_auth_tag: text("discord_id_auth_tag"),
    discord_id_kms_key_id: text("discord_id_kms_key_id"),
    discord_id_kms_key_version: integer("discord_id_kms_key_version"),

    // Lifecycle
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    deleted_at: timestamp("deleted_at"),
  },
  (table) => ({
    email_idx: index("users_email_idx").on(table.email),
    email_blind_index_idx: index("users_email_blind_index_idx").on(table.email_blind_index),
    wallet_address_idx: index("users_wallet_address_idx").on(table.wallet_address),
    wallet_blind_index_idx: index("users_wallet_blind_index_idx").on(
      table.wallet_address_blind_index,
    ),
    wallet_chain_type_idx: index("users_wallet_chain_type_idx").on(table.wallet_chain_type),
    organization_idx: index("users_organization_idx").on(table.organization_id),
    is_active_idx: index("users_is_active_idx").on(table.is_active),
    steward_idx: index("users_steward_idx").on(table.steward_user_id),
    telegram_idx: index("users_telegram_idx").on(table.telegram_id),
    discord_idx: index("users_discord_idx").on(table.discord_id),
    phone_idx: index("users_phone_idx").on(table.phone_number),
    phone_blind_index_idx: index("users_phone_blind_index_idx").on(table.phone_blind_index),
    is_anonymous_idx: index("users_is_anonymous_idx").on(table.is_anonymous),
    deleted_at_idx: index("users_deleted_at_idx").on(table.deleted_at),
    anonymous_session_id_partial_idx: index("users_anonymous_session_id_partial_idx")
      .on(table.anonymous_session_id)
      .where(sql`${table.anonymous_session_id} IS NOT NULL`),
  }),
);

// Type inference
export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;
