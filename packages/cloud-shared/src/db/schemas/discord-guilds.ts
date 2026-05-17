import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Discord Guilds (Servers) table schema.
 *
 * Stores Discord servers where the bot has been added via OAuth2.
 * Populated when user completes OAuth flow to add bot to their server.
 */
export const discordGuilds = pgTable(
  "discord_guilds",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    guild_id: text("guild_id").notNull(), // Discord snowflake ID
    guild_name: text("guild_name").notNull(),
    icon_hash: text("icon_hash"), // For guild icon URL construction
    owner_id: text("owner_id"), // Discord user ID who added the bot
    bot_permissions: text("bot_permissions"), // Bitfield of granted permissions

    bot_joined_at: timestamp("bot_joined_at", { withTimezone: true }).defaultNow().notNull(),
    is_active: boolean("is_active").default(true).notNull(),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("discord_guilds_organization_id_idx").on(table.organization_id),
    index("discord_guilds_guild_id_idx").on(table.guild_id),
    index("discord_guilds_org_guild_idx").on(table.organization_id, table.guild_id),
  ],
);

export type DiscordGuild = InferSelectModel<typeof discordGuilds>;
export type NewDiscordGuild = InferInsertModel<typeof discordGuilds>;
