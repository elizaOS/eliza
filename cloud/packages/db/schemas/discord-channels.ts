import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Discord Channels table schema.
 *
 * Stores channels within Discord guilds where the bot can operate.
 * Cached from Discord API and refreshed periodically.
 */
export const discordChannels = pgTable(
  "discord_channels",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    guild_id: text("guild_id").notNull(), // Discord guild snowflake
    channel_id: text("channel_id").notNull(), // Discord channel snowflake
    channel_name: text("channel_name").notNull(),
    channel_type: integer("channel_type").notNull(), // Discord ChannelType enum value
    parent_id: text("parent_id"), // Category channel ID if nested
    position: integer("position"), // Channel ordering

    can_send_messages: boolean("can_send_messages").default(true).notNull(),
    can_embed_links: boolean("can_embed_links").default(true).notNull(),
    can_attach_files: boolean("can_attach_files").default(true).notNull(),
    is_nsfw: boolean("is_nsfw").default(false).notNull(),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("discord_channels_organization_id_idx").on(table.organization_id),
    index("discord_channels_guild_id_idx").on(table.guild_id),
    index("discord_channels_channel_id_idx").on(table.channel_id),
    index("discord_channels_guild_channel_idx").on(table.guild_id, table.channel_id),
  ],
);

export type DiscordChannel = InferSelectModel<typeof discordChannels>;
export type NewDiscordChannel = InferInsertModel<typeof discordChannels>;
