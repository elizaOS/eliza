import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    steward_user_id: text("steward_user_id").unique(),
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

    // Lifecycle
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    email_idx: index("users_email_idx").on(table.email),
    wallet_address_idx: index("users_wallet_address_idx").on(table.wallet_address),
    wallet_chain_type_idx: index("users_wallet_chain_type_idx").on(table.wallet_chain_type),
    organization_idx: index("users_organization_idx").on(table.organization_id),
    is_active_idx: index("users_is_active_idx").on(table.is_active),
    steward_idx: index("users_steward_idx").on(table.steward_user_id),
    telegram_idx: index("users_telegram_idx").on(table.telegram_id),
    discord_idx: index("users_discord_idx").on(table.discord_id),
    phone_idx: index("users_phone_idx").on(table.phone_number),
    is_anonymous_idx: index("users_is_anonymous_idx").on(table.is_anonymous),
    anonymous_session_id_partial_idx: index("users_anonymous_session_id_partial_idx")
      .on(table.anonymous_session_id)
      .where(sql`${table.anonymous_session_id} IS NOT NULL`),
  }),
);

// Type inference
export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;
