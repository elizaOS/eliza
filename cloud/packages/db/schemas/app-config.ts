import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { apps } from "./apps";

/**
 * App config table schema.
 *
 * Stores social media automation configs, promotional assets, feature flags,
 * and linked character IDs. Split from the main apps table to reduce row size.
 */
export const appConfig = pgTable(
  "app_config",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .unique()
      .references(() => apps.id, { onDelete: "cascade" }),

    // App features/permissions
    features_enabled: jsonb("features_enabled")
      .$type<{
        chat?: boolean;
        image?: boolean;
        video?: boolean;
        voice?: boolean;
        agents?: boolean;
        embedding?: boolean;
      }>()
      .notNull()
      .default({
        chat: true,
        image: false,
        video: false,
        voice: false,
        agents: false,
        embedding: false,
      }),

    // Twitter Automation / Vibe Marketing
    twitter_automation: jsonb("twitter_automation")
      .$type<{
        enabled: boolean;
        autoPost: boolean;
        autoReply: boolean;
        autoEngage: boolean;
        discovery: boolean;
        postIntervalMin: number;
        postIntervalMax: number;
        vibeStyle?: string;
        topics?: string[];
        lastPostAt?: string;
        totalPosts?: number;
        agentCharacterId?: string;
      }>()
      .default({
        enabled: false,
        autoPost: false,
        autoReply: false,
        autoEngage: false,
        discovery: false,
        postIntervalMin: 90,
        postIntervalMax: 150,
      }),

    // Telegram Bot Automation
    telegram_automation: jsonb("telegram_automation")
      .$type<{
        enabled: boolean;
        botUsername?: string;
        channelId?: string;
        groupId?: string;
        autoReply: boolean;
        autoAnnounce: boolean;
        announceIntervalMin: number;
        announceIntervalMax: number;
        welcomeMessage?: string;
        vibeStyle?: string;
        lastAnnouncementAt?: string;
        totalMessages?: number;
      }>()
      .default({
        enabled: false,
        autoReply: true,
        autoAnnounce: false,
        announceIntervalMin: 120,
        announceIntervalMax: 240,
      }),

    // Discord Bot Automation
    discord_automation: jsonb("discord_automation")
      .$type<{
        enabled: boolean;
        guildId?: string;
        channelId?: string;
        autoAnnounce: boolean;
        announceIntervalMin: number;
        announceIntervalMax: number;
        vibeStyle?: string;
        lastAnnouncementAt?: string;
        totalMessages?: number;
      }>()
      .default({
        enabled: false,
        autoAnnounce: false,
        announceIntervalMin: 120,
        announceIntervalMax: 240,
      }),

    // Promotional Assets
    promotional_assets: jsonb("promotional_assets")
      .$type<
        Array<{
          type: "social_card" | "banner";
          url: string;
          size: { width: number; height: number };
          generatedAt: string;
        }>
      >()
      .default([]),

    // Linked characters (max 4 AI agents)
    linked_character_ids: jsonb("linked_character_ids").$type<string[]>().default([]).notNull(),

    // GitHub repository
    github_repo: text("github_repo"),

    // Lifecycle
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    app_idx: index("app_config_app_idx").on(table.app_id),
  }),
);

// Type inference
export type AppConfig = InferSelectModel<typeof appConfig>;
export type NewAppConfig = InferInsertModel<typeof appConfig>;
