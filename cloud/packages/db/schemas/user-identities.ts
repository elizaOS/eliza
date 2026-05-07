import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * User identities table schema.
 *
 * Stores external authentication identities (Steward, Telegram, Discord, WhatsApp, phone)
 * and anonymous session tracking. Split from the main users table to reduce row size
 * on the heavily-read core table.
 */
export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    user_id: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),

    // Steward authentication
    steward_user_id: text("steward_user_id").unique(),

    // Anonymous user support
    is_anonymous: boolean("is_anonymous").notNull().default(false),
    anonymous_session_id: text("anonymous_session_id").unique(),
    expires_at: timestamp("expires_at"), // Auto-cleanup for anonymous users (7 days)

    // Telegram identity (Eliza App)
    telegram_id: text("telegram_id").unique(),
    telegram_username: text("telegram_username"),
    telegram_first_name: text("telegram_first_name"),
    telegram_photo_url: text("telegram_photo_url"),

    // Phone identity (Eliza App - iMessage)
    phone_number: text("phone_number").unique(),
    phone_verified: boolean("phone_verified").default(false),

    // Discord identity (Eliza App)
    discord_id: text("discord_id").unique(),
    discord_username: text("discord_username"),
    discord_global_name: text("discord_global_name"),
    discord_avatar_url: text("discord_avatar_url"),

    // WhatsApp identity (Eliza App)
    whatsapp_id: text("whatsapp_id").unique(),
    whatsapp_name: text("whatsapp_name"),

    // Lifecycle
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    user_idx: index("user_identities_user_idx").on(table.user_id),
    steward_user_id_idx: index("user_identities_steward_user_id_idx").on(table.steward_user_id),
    is_anonymous_idx: index("user_identities_is_anonymous_idx").on(table.is_anonymous),
    anonymous_session_idx: index("user_identities_anonymous_session_idx").on(
      table.anonymous_session_id,
    ),
    expires_at_idx: index("user_identities_expires_at_idx").on(table.expires_at),
    telegram_id_idx: index("user_identities_telegram_id_idx").on(table.telegram_id),
    phone_number_idx: index("user_identities_phone_number_idx").on(table.phone_number),
    discord_id_idx: index("user_identities_discord_id_idx").on(table.discord_id),
    whatsapp_id_idx: index("user_identities_whatsapp_id_idx").on(table.whatsapp_id),
  }),
);

// Type inference
export type UserIdentity = InferSelectModel<typeof userIdentities>;
export type NewUserIdentity = InferInsertModel<typeof userIdentities>;
