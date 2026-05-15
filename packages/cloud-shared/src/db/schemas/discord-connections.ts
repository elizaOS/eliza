import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { organizations } from "./organizations";
import { userCharacters } from "./user-characters";

/**
 * Zod schema for runtime validation of Discord connection metadata.
 * Use this when accepting metadata from external sources (APIs, user input).
 */
export const DiscordConnectionMetadataSchema = z
  .object({
    enabledChannels: z.array(z.string()).optional(),
    disabledChannels: z.array(z.string()).optional(),
    responseMode: z.enum(["always", "mention", "keyword"]).optional(),
    keywords: z.array(z.string()).optional(),
  })
  .refine(
    (data) => {
      // If responseMode is "keyword", keywords must be provided
      if (data.responseMode === "keyword") {
        return data.keywords && data.keywords.length > 0;
      }
      return true;
    },
    {
      message: "keywords array is required when responseMode is 'keyword'",
      path: ["keywords"],
    },
  )
  .optional();

export type DiscordConnectionMetadata = z.infer<typeof DiscordConnectionMetadataSchema>;

/**
 * Discord Gateway Intents
 * @see https://discord.com/developers/docs/topics/gateway#gateway-intents
 */
export const DISCORD_DEFAULT_INTENTS =
  (1 << 0) | // GUILDS
  (1 << 9) | // GUILD_MESSAGES
  (1 << 10) | // GUILD_MESSAGE_REACTIONS
  (1 << 12) | // DIRECT_MESSAGES
  (1 << 15); // MESSAGE_CONTENT (privileged)

/**
 * Discord Connections table schema.
 *
 * Tracks Discord bot connections managed by the gateway service.
 * Each connection represents a bot token assigned to a gateway pod.
 *
 * Bot tokens are encrypted at rest using envelope encryption:
 * - Data Encryption Key (DEK) encrypts the token with AES-256-GCM
 * - Key Encryption Key (KEK) from KMS encrypts the DEK
 */
export const discordConnections = pgTable(
  "discord_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // Character ID - links to the agent character that will respond
    character_id: uuid("character_id").references(() => userCharacters.id, {
      onDelete: "set null",
    }),

    // Discord application info - one connection per application
    application_id: text("application_id").notNull(),
    // Bot user ID (different from application_id) - set when bot connects
    // Used for mention detection since Discord mentions use user ID, not app ID
    bot_user_id: text("bot_user_id"),

    // Encrypted bot token (AES-256-GCM envelope encryption)
    bot_token_encrypted: text("bot_token_encrypted").notNull(),
    encrypted_dek: text("encrypted_dek").notNull(),
    token_nonce: text("token_nonce").notNull(),
    token_auth_tag: text("token_auth_tag").notNull(),
    encryption_key_id: text("encryption_key_id").notNull(),

    // Gateway assignment
    assigned_pod: text("assigned_pod"),
    status: text("status").notNull().default("pending"), // pending, connecting, connected, disconnected, error
    error_message: text("error_message"),

    // Connection stats
    guild_count: integer("guild_count").default(0),
    events_received: integer("events_received").default(0),
    events_routed: integer("events_routed").default(0),

    // Heartbeat tracking
    last_heartbeat: timestamp("last_heartbeat", { withTimezone: true }),
    connected_at: timestamp("connected_at", { withTimezone: true }),

    // Configuration
    intents: integer("intents").default(DISCORD_DEFAULT_INTENTS),
    is_active: boolean("is_active").default(true).notNull(),

    /**
     * Bot behavior configuration metadata.
     *
     * @property {string[]} enabledChannels - Channel IDs where the bot WILL respond.
     *   If set, bot only responds in these channels (allowlist mode).
     *   If empty/undefined, bot responds in all channels (subject to disabledChannels).
     *
     * @property {string[]} disabledChannels - Channel IDs where the bot will NOT respond.
     *   Used as a blocklist. Checked after enabledChannels.
     *
     * @property {"always" | "mention" | "keyword"} responseMode - When the bot responds:
     *   - "always": Responds to every message in enabled channels (default behavior)
     *   - "mention": Only responds when the bot is @mentioned in the message
     *   - "keyword": Only responds when message contains one of the configured keywords
     *
     * @property {string[]} keywords - Trigger words for "keyword" responseMode.
     *   Case-insensitive substring matching. Required when responseMode is "keyword".
     *
     * @example
     * // Bot responds only when mentioned in #general channel
     * {
     *   enabledChannels: ["123456789"],
     *   responseMode: "mention"
     * }
     *
     * @example
     * // Bot responds to messages containing "help" or "support"
     * {
     *   responseMode: "keyword",
     *   keywords: ["help", "support"]
     * }
     */
    metadata: jsonb("metadata").$type<DiscordConnectionMetadata>(),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("discord_connections_organization_id_idx").on(table.organization_id),
    index("discord_connections_character_id_idx").on(table.character_id),
    // One bot per Discord application per organization
    uniqueIndex("discord_connections_org_app_unique_idx").on(
      table.organization_id,
      table.application_id,
    ),
    index("discord_connections_assigned_pod_idx").on(table.assigned_pod),
    index("discord_connections_status_idx").on(table.status),
    index("discord_connections_is_active_idx").on(table.is_active),
  ],
);

export type DiscordConnection = InferSelectModel<typeof discordConnections>;
export type NewDiscordConnection = InferInsertModel<typeof discordConnections>;
