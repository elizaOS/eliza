import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * App deployment status enum.
 */
export const appDeploymentStatusEnum = pgEnum("app_deployment_status", [
  "draft",
  "building",
  "deploying",
  "deployed",
  "failed",
]);

export type AppDeploymentStatus = "draft" | "building" | "deploying" | "deployed" | "failed";

/**
 * User database provisioning status enum.
 */
export const userDatabaseStatusEnum = pgEnum("user_database_status", [
  "none",
  "provisioning",
  "ready",
  "error",
]);

export type UserDatabaseStatus = "none" | "provisioning" | "ready" | "error";

/**
 * Apps table schema (core).
 *
 * Contains essential app identification, ownership, and status.
 *
 * NOTE: `github_repo`, `linked_character_ids`, and `monetization_enabled` are kept
 * here because they're deeply used across app-builder routes and the chat system.
 * The app_config/app_billing tables serve as read-optimized projections for
 * less-frequently-accessed config (automation configs, promotional assets, etc.).
 *
 * Extended automation/features/assets → app_config table
 * Extended billing/rate limits → app_billing table
 * Database provisioning → app_databases table
 */
export const apps = pgTable(
  "apps",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // App identification
    name: text("name").notNull(),
    description: text("description"),
    slug: text("slug").notNull().unique(),

    // App owner
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    created_by_user_id: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // App URL
    app_url: text("app_url").notNull(),
    allowed_origins: jsonb("allowed_origins").$type<string[]>().notNull().default([]),

    // API Key
    api_key_id: uuid("api_key_id").unique(),

    // Affiliate tracking
    affiliate_code: text("affiliate_code").unique(),
    referral_bonus_credits: numeric("referral_bonus_credits", {
      precision: 10,
      scale: 2,
    }).default("0.00"),

    // Usage tracking
    total_requests: integer("total_requests").default(0).notNull(),
    total_users: integer("total_users").default(0).notNull(),
    total_credits_used: numeric("total_credits_used", {
      precision: 10,
      scale: 2,
    }).default("0.00"),

    // App metadata
    logo_url: text("logo_url"),
    website_url: text("website_url"),
    contact_email: text("contact_email"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),

    // Deployment status
    deployment_status: appDeploymentStatusEnum("deployment_status").notNull().default("draft"),
    production_url: text("production_url"),
    last_deployed_at: timestamp("last_deployed_at"),

    // GitHub integration (kept for app-builder routes)
    github_repo: text("github_repo"),

    // Character linking (kept for characters API)
    linked_character_ids: jsonb("linked_character_ids").$type<string[]>().default([]),

    // Monetization (kept for chat system)
    monetization_enabled: boolean("monetization_enabled").default(false).notNull(),
    inference_markup_percentage: real("inference_markup_percentage").default(0),
    purchase_share_percentage: real("purchase_share_percentage").default(0),
    platform_offset_amount: real("platform_offset_amount").default(0),
    custom_pricing_enabled: boolean("custom_pricing_enabled").default(false),
    total_creator_earnings: numeric("total_creator_earnings", {
      precision: 12,
      scale: 6,
    }).default("0.000000"),
    total_platform_revenue: numeric("total_platform_revenue", {
      precision: 12,
      scale: 6,
    }).default("0.000000"),

    // Social automation configs (kept for automation services)
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

    // Promotional assets (kept for promo routes)
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

    // Email notifications
    email_notifications: boolean("email_notifications").default(true),
    response_notifications: boolean("response_notifications").default(true),

    // Status
    is_active: boolean("is_active").default(true).notNull(),
    is_approved: boolean("is_approved").default(true).notNull(),

    // Timestamps
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    last_used_at: timestamp("last_used_at"),
  },
  (table) => ({
    slug_idx: index("apps_slug_idx").on(table.slug),
    organization_idx: index("apps_organization_idx").on(table.organization_id),
    created_by_idx: index("apps_created_by_idx").on(table.created_by_user_id),
    affiliate_code_idx: index("apps_affiliate_code_idx").on(table.affiliate_code),
    is_active_idx: index("apps_is_active_idx").on(table.is_active),
    created_at_idx: index("apps_created_at_idx").on(table.created_at),
  }),
);

/**
 * App users table schema.
 */
export const appUsers = pgTable(
  "app_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    signup_source: text("signup_source"),
    referral_code_used: text("referral_code_used"),
    ip_address: text("ip_address"),
    user_agent: text("user_agent"),

    total_requests: integer("total_requests").default(0).notNull(),
    total_credits_used: numeric("total_credits_used", {
      precision: 10,
      scale: 2,
    }).default("0.00"),

    first_seen_at: timestamp("first_seen_at").notNull().defaultNow(),
    last_seen_at: timestamp("last_seen_at").notNull().defaultNow(),

    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (table) => ({
    app_user_unique_idx: uniqueIndex("app_users_app_user_idx").on(table.app_id, table.user_id),
    app_id_idx: index("app_users_app_id_idx").on(table.app_id),
    user_id_idx: index("app_users_user_id_idx").on(table.user_id),
    first_seen_idx: index("app_users_first_seen_idx").on(table.first_seen_at),
  }),
);

/**
 * App analytics table schema.
 */
export const appAnalytics = pgTable(
  "app_analytics",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),

    period_start: timestamp("period_start").notNull(),
    period_end: timestamp("period_end").notNull(),
    period_type: text("period_type").notNull(),

    total_requests: integer("total_requests").default(0).notNull(),
    successful_requests: integer("successful_requests").default(0).notNull(),
    failed_requests: integer("failed_requests").default(0).notNull(),
    unique_users: integer("unique_users").default(0).notNull(),
    new_users: integer("new_users").default(0).notNull(),

    total_input_tokens: integer("total_input_tokens").default(0).notNull(),
    total_output_tokens: integer("total_output_tokens").default(0).notNull(),
    total_cost: numeric("total_cost", { precision: 10, scale: 2 }).default("0.00"),
    total_credits_used: numeric("total_credits_used", {
      precision: 10,
      scale: 2,
    }).default("0.00"),

    chat_requests: integer("chat_requests").default(0).notNull(),
    image_requests: integer("image_requests").default(0).notNull(),
    video_requests: integer("video_requests").default(0).notNull(),
    voice_requests: integer("voice_requests").default(0).notNull(),
    agent_requests: integer("agent_requests").default(0).notNull(),

    avg_response_time_ms: integer("avg_response_time_ms"),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    app_id_idx: index("app_analytics_app_id_idx").on(table.app_id),
    period_idx: index("app_analytics_period_idx").on(table.period_start, table.period_end),
    period_type_idx: index("app_analytics_period_type_idx").on(table.period_type),
    app_period_idx: index("app_analytics_app_period_idx").on(table.app_id, table.period_start),
  }),
);

/**
 * App requests table schema.
 */
export const appRequests = pgTable(
  "app_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),

    request_type: text("request_type").notNull(),
    source: text("source").notNull().default("api_key"),

    ip_address: text("ip_address"),
    user_agent: text("user_agent"),
    country: text("country"),
    city: text("city"),

    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    model: text("model"),
    input_tokens: integer("input_tokens").default(0),
    output_tokens: integer("output_tokens").default(0),
    credits_used: numeric("credits_used", { precision: 10, scale: 6 }).default("0.00"),

    response_time_ms: integer("response_time_ms"),
    status: text("status").notNull().default("success"),
    error_message: text("error_message"),

    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    app_id_idx: index("app_requests_app_id_idx").on(table.app_id),
    created_at_idx: index("app_requests_created_at_idx").on(table.created_at),
    request_type_idx: index("app_requests_type_idx").on(table.request_type),
    source_idx: index("app_requests_source_idx").on(table.source),
    ip_idx: index("app_requests_ip_idx").on(table.ip_address),
    app_created_idx: index("app_requests_app_created_idx").on(table.app_id, table.created_at),
  }),
);

// Type inference
export type App = InferSelectModel<typeof apps>;
export type NewApp = InferInsertModel<typeof apps>;
export type AppUser = InferSelectModel<typeof appUsers>;
export type NewAppUser = InferInsertModel<typeof appUsers>;
export type AppAnalytics = InferSelectModel<typeof appAnalytics>;
export type NewAppAnalytics = InferInsertModel<typeof appAnalytics>;
export type AppRequest = InferSelectModel<typeof appRequests>;
export type NewAppRequest = InferInsertModel<typeof appRequests>;
