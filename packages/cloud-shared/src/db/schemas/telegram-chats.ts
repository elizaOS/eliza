import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { bigint, boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Telegram Chats table schema.
 *
 * Stores channels and groups where the organization's bot is a member.
 * Automatically populated when the bot is added/removed from chats.
 */
export const telegramChats = pgTable(
  "telegram_chats",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    chat_id: bigint("chat_id", { mode: "number" }).notNull(),
    chat_type: text("chat_type").notNull(), // "channel", "group", "supergroup"
    title: text("title").notNull(),
    username: text("username"), // @username if public

    is_admin: boolean("is_admin").default(false).notNull(),
    can_post_messages: boolean("can_post_messages").default(false).notNull(),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("telegram_chats_organization_id_idx").on(table.organization_id),
    index("telegram_chats_chat_id_idx").on(table.chat_id),
  ],
);

export type TelegramChat = InferSelectModel<typeof telegramChats>;
export type NewTelegramChat = InferInsertModel<typeof telegramChats>;
