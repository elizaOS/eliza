import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import { organizations } from "./organizations";

/**
 * Users table schema.
 *
 * Stores user accounts with support for both authenticated (Privy) and anonymous users.
 * Anonymous users are tracked via session cookies and have limited functionality.
 *
 * Also supports Eliza App authentication via Telegram and phone number (iMessage).
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Privy authentication - NULLABLE to support anonymous users
    privy_user_id: text("privy_user_id").unique(), // NULL for anonymous users

    // Anonymous user support
    is_anonymous: boolean("is_anonymous").notNull().default(false),
    anonymous_session_id: text("anonymous_session_id").unique(), // Links to session cookie

    // Telegram identity (Eliza App)
    telegram_id: text("telegram_id").unique(), // Telegram user ID (stored as text for bigint safety)
    telegram_username: text("telegram_username"), // @username without the @
    telegram_first_name: text("telegram_first_name"), // Display name from Telegram
    telegram_photo_url: text("telegram_photo_url"), // Profile photo URL

    // Phone identity (Eliza App - iMessage)
    phone_number: text("phone_number").unique(), // E.164 format: +1234567890
    phone_verified: boolean("phone_verified").default(false),

    // Device identity (Milaidy desktop/mobile auto-signup)
    device_id: text("device_id").unique(), // SHA-256 hash of hardware fingerprint
    device_platform: text("device_platform"), // ios, android, macos, windows, linux

    // User profile
    email: text("email").unique(),
    email_verified: boolean("email_verified").default(false),
    wallet_address: text("wallet_address").unique(),
    wallet_chain_type: text("wallet_chain_type"),
    wallet_verified: boolean("wallet_verified").default(false).notNull(),
    name: text("name"),
    nickname: text("nickname"),
    work_function: text("work_function"),
    preferences: text("preferences"),
    response_notifications: boolean("response_notifications").default(true),
    email_notifications: boolean("email_notifications").default(true),

    // Organization - NULLABLE for anonymous users
    organization_id: uuid("organization_id").references(
      () => organizations.id,
      {
        onDelete: "cascade",
      },
    ),
    role: text("role").notNull().default("member"),

    avatar: text("avatar"),
    is_active: boolean("is_active").default(true).notNull(),

    // Lifecycle
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    expires_at: timestamp("expires_at"), // Auto-cleanup for anonymous users (7 days)
  },
  (table) => ({
    email_idx: index("users_email_idx").on(table.email),
    wallet_address_idx: index("users_wallet_address_idx").on(
      table.wallet_address,
    ),
    wallet_chain_type_idx: index("users_wallet_chain_type_idx").on(
      table.wallet_chain_type,
    ),
    organization_idx: index("users_organization_idx").on(table.organization_id),
    is_active_idx: index("users_is_active_idx").on(table.is_active),
    privy_user_id_idx: index("users_privy_user_id_idx").on(table.privy_user_id),
    is_anonymous_idx: index("users_is_anonymous_idx").on(table.is_anonymous),
    anonymous_session_idx: index("users_anonymous_session_idx").on(
      table.anonymous_session_id,
    ),
    expires_at_idx: index("users_expires_at_idx").on(table.expires_at),
    work_function_idx: index("users_work_function_idx").on(table.work_function),
    // Eliza App identity indexes
    telegram_id_idx: index("users_telegram_id_idx").on(table.telegram_id),
    phone_number_idx: index("users_phone_number_idx").on(table.phone_number),
    // Device identity indexes (Milaidy)
    device_id_idx: index("users_device_id_idx").on(table.device_id),
  }),
);

// Type inference
export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;
