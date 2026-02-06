import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * App deployment status enum.
 * Tracks the deployment lifecycle of an app.
 */
export const appDeploymentStatusEnum = pgEnum("app_deployment_status", [
  "draft", // App created but not yet deployed
  "building", // App is being built
  "deploying", // App is being deployed to production
  "deployed", // App is live and accessible
  "failed", // Deployment failed
]);

export type AppDeploymentStatus =
  | "draft"
  | "building"
  | "deploying"
  | "deployed"
  | "failed";

/**
 * User database provisioning status enum.
 * Tracks the provisioning lifecycle of a user's Neon database.
 */
export const userDatabaseStatusEnum = pgEnum("user_database_status", [
  "none", // No database requested/provisioned
  "provisioning", // Database creation in progress
  "ready", // Database ready for use
  "error", // Provisioning failed
]);

export type UserDatabaseStatus = "none" | "provisioning" | "ready" | "error";

/**
 * Apps table schema.
 *
 * Represents third-party applications that integrate with the Eliza Cloud platform.
 * Apps can embed agents, use the API, and track their usage and users.
 */
export const apps = pgTable(
  "apps",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // App identification
    name: text("name").notNull(),
    description: text("description"),
    slug: text("slug").notNull().unique(), // URL-friendly identifier

    // App owner
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    created_by_user_id: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // App URL and security
    app_url: text("app_url").notNull(), // Primary app URL

    // GitHub repository for this app (org/repo format or just repo name)
    github_repo: text("github_repo"), // e.g., "eliza-cloud-apps/app-my-app"
    allowed_origins: jsonb("allowed_origins")
      .$type<string[]>()
      .notNull()
      .default([]), // URL whitelist for CORS/security

    // API Key for this app (generated automatically)
    api_key_id: uuid("api_key_id").unique(), // References api_keys table

    // Affiliate tracking
    affiliate_code: text("affiliate_code").unique(), // Optional affiliate code
    referral_bonus_credits: numeric("referral_bonus_credits", {
      precision: 10,
      scale: 2,
    }).default("0.00"), // Credits awarded for referrals

    // Usage tracking
    total_requests: integer("total_requests").default(0).notNull(),
    total_users: integer("total_users").default(0).notNull(), // Users signed up through this app
    total_credits_used: numeric("total_credits_used", {
      precision: 10,
      scale: 2,
    }).default("0.00"),

    // LLM Usage pricing (can override organization defaults)
    custom_pricing_enabled: boolean("custom_pricing_enabled")
      .default(false)
      .notNull(),

    // Monetization settings
    monetization_enabled: boolean("monetization_enabled")
      .default(false)
      .notNull(),
    inference_markup_percentage: numeric("inference_markup_percentage", {
      precision: 7,
      scale: 2,
    })
      .default("0.00")
      .notNull(), // 0-1000% markup on inference costs
    purchase_share_percentage: numeric("purchase_share_percentage", {
      precision: 5,
      scale: 2,
    })
      .default("10.00")
      .notNull(), // % of credit purchases creator earns (default 10%)
    platform_offset_amount: numeric("platform_offset_amount", {
      precision: 10,
      scale: 2,
    })
      .default("1.00")
      .notNull(), // Platform takes this amount to offset costs

    // Creator earnings tracking (summary)
    total_creator_earnings: numeric("total_creator_earnings", {
      precision: 12,
      scale: 6,
    })
      .default("0.000000")
      .notNull(),
    total_platform_revenue: numeric("total_platform_revenue", {
      precision: 12,
      scale: 6,
    })
      .default("0.000000")
      .notNull(),

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

    // Rate limiting
    rate_limit_per_minute: integer("rate_limit_per_minute").default(60),
    rate_limit_per_hour: integer("rate_limit_per_hour").default(1000),

    // App metadata
    logo_url: text("logo_url"),
    website_url: text("website_url"),
    contact_email: text("contact_email"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),

    // Twitter Automation / Vibe Marketing
    twitter_automation: jsonb("twitter_automation")
      .$type<{
        enabled: boolean;
        autoPost: boolean;
        autoReply: boolean;
        autoEngage: boolean;
        discovery: boolean;
        postIntervalMin: number; // minutes
        postIntervalMax: number; // minutes
        vibeStyle?: string; // e.g., "professional", "casual", "witty"
        topics?: string[]; // additional topics to post about
        lastPostAt?: string; // ISO timestamp
        totalPosts?: number;
        agentCharacterId?: string; // the character used for automation
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
        channelId?: string; // Primary announcement channel
        groupId?: string; // Community group (optional)
        autoReply: boolean; // Reply to messages in groups
        autoAnnounce: boolean; // Periodic announcements
        announceIntervalMin: number; // minutes
        announceIntervalMax: number; // minutes
        welcomeMessage?: string; // Custom /start response
        vibeStyle?: string; // e.g., "professional", "casual", "witty"
        lastAnnouncementAt?: string; // ISO timestamp
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
        guildId?: string; // Primary guild for automation
        channelId?: string; // Announcement channel
        autoAnnounce: boolean; // Periodic announcements
        announceIntervalMin: number; // minutes
        announceIntervalMax: number; // minutes
        vibeStyle?: string; // e.g., "professional", "casual", "witty"
        lastAnnouncementAt?: string; // ISO timestamp
        totalMessages?: number;
      }>()
      .default({
        enabled: false,
        autoAnnounce: false,
        announceIntervalMin: 120,
        announceIntervalMax: 240,
      }),

    // Promotional Assets - AI-generated images for campaigns
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

    // Linked characters (max 4 AI agents that can be used in this app)
    linked_character_ids: jsonb("linked_character_ids")
      .$type<string[]>()
      .default([])
      .notNull(),

    // Deployment status
    deployment_status: appDeploymentStatusEnum("deployment_status")
      .notNull()
      .default("draft"),
    production_url: text("production_url"), // Actual deployed URL (only set after successful deployment)
    last_deployed_at: timestamp("last_deployed_at"), // When the app was last deployed

    // Status
    is_active: boolean("is_active").default(true).notNull(),
    is_approved: boolean("is_approved").default(true).notNull(), // For app review process

    // === User Database (Neon Serverless Postgres for Stateful Apps) ===

    /**
     * Encrypted connection URI to the user's provisioned Neon database.
     * Format: postgres://user:password@host/database?sslmode=require
     * SENSITIVE: Never expose to client code or logs.
     */
    user_database_uri: text("user_database_uri"),

    /**
     * Neon project ID for API operations (delete, status checks).
     * Format: "proj_xxxxxxxxxxxx"
     */
    user_database_project_id: text("user_database_project_id"),

    /**
     * Neon branch ID (primary branch created with project).
     * Format: "br_xxxxxxxxxxxx"
     */
    user_database_branch_id: text("user_database_branch_id"),

    /**
     * AWS region where the database is provisioned.
     * Default: "aws-us-east-1" (matches our primary infrastructure)
     */
    user_database_region: text("user_database_region").default("aws-us-east-1"),

    /**
     * Current provisioning status of the database.
     * State machine: none → provisioning → ready | error
     */
    user_database_status: userDatabaseStatusEnum("user_database_status")
      .notNull()
      .default("none"),

    /**
     * Error message if provisioning failed.
     * Cleared when retrying provisioning.
     */
    user_database_error: text("user_database_error"),

    // Timestamps
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    last_used_at: timestamp("last_used_at"),
  },
  (table) => ({
    slug_idx: index("apps_slug_idx").on(table.slug),
    organization_idx: index("apps_organization_idx").on(table.organization_id),
    created_by_idx: index("apps_created_by_idx").on(table.created_by_user_id),
    affiliate_code_idx: index("apps_affiliate_code_idx").on(
      table.affiliate_code,
    ),
    is_active_idx: index("apps_is_active_idx").on(table.is_active),
    created_at_idx: index("apps_created_at_idx").on(table.created_at),
    // Index for querying apps with databases (exclude 'none' status)
    user_database_status_idx: index("apps_user_database_status_idx").on(
      table.user_database_status,
    ),
  }),
);

/**
 * App users table schema.
 *
 * Tracks users who have signed up or used the platform through a specific app.
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

    // Tracking info
    signup_source: text("signup_source"), // How they signed up (direct, affiliate, etc.)
    referral_code_used: text("referral_code_used"), // If they used a referral code
    ip_address: text("ip_address"),
    user_agent: text("user_agent"),

    // Usage stats for this user in this app
    total_requests: integer("total_requests").default(0).notNull(),
    total_credits_used: numeric("total_credits_used", {
      precision: 10,
      scale: 2,
    }).default("0.00"),

    // Timestamps
    first_seen_at: timestamp("first_seen_at").notNull().defaultNow(),
    last_seen_at: timestamp("last_seen_at").notNull().defaultNow(),

    // Metadata
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
  },
  (table) => ({
    app_user_unique_idx: uniqueIndex("app_users_app_user_idx").on(
      table.app_id,
      table.user_id,
    ),
    app_id_idx: index("app_users_app_id_idx").on(table.app_id),
    user_id_idx: index("app_users_user_id_idx").on(table.user_id),
    first_seen_idx: index("app_users_first_seen_idx").on(table.first_seen_at),
  }),
);

/**
 * App analytics table schema.
 *
 * Daily/hourly aggregated analytics for each app.
 */
export const appAnalytics = pgTable(
  "app_analytics",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),

    // Time period
    period_start: timestamp("period_start").notNull(),
    period_end: timestamp("period_end").notNull(),
    period_type: text("period_type").notNull(), // 'hourly', 'daily', 'monthly'

    // Metrics
    total_requests: integer("total_requests").default(0).notNull(),
    successful_requests: integer("successful_requests").default(0).notNull(),
    failed_requests: integer("failed_requests").default(0).notNull(),
    unique_users: integer("unique_users").default(0).notNull(),
    new_users: integer("new_users").default(0).notNull(),

    // Cost metrics
    total_input_tokens: integer("total_input_tokens").default(0).notNull(),
    total_output_tokens: integer("total_output_tokens").default(0).notNull(),
    total_cost: numeric("total_cost", { precision: 10, scale: 2 }).default(
      "0.00",
    ),
    total_credits_used: numeric("total_credits_used", {
      precision: 10,
      scale: 2,
    }).default("0.00"),

    // Feature usage breakdown
    chat_requests: integer("chat_requests").default(0).notNull(),
    image_requests: integer("image_requests").default(0).notNull(),
    video_requests: integer("video_requests").default(0).notNull(),
    voice_requests: integer("voice_requests").default(0).notNull(),
    agent_requests: integer("agent_requests").default(0).notNull(),

    // Average metrics
    avg_response_time_ms: integer("avg_response_time_ms"),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    app_id_idx: index("app_analytics_app_id_idx").on(table.app_id),
    period_idx: index("app_analytics_period_idx").on(
      table.period_start,
      table.period_end,
    ),
    period_type_idx: index("app_analytics_period_type_idx").on(
      table.period_type,
    ),
    // Composite index for querying app analytics by time period
    app_period_idx: index("app_analytics_app_period_idx").on(
      table.app_id,
      table.period_start,
    ),
  }),
);

/**
 * App requests table schema.
 *
 * Logs individual API requests for detailed analytics and debugging.
 * Provides granular visibility into app usage patterns.
 */
export const appRequests = pgTable(
  "app_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),

    request_type: text("request_type").notNull(), // 'chat', 'image', 'video', 'voice', 'agent'
    source: text("source").notNull().default("api_key"), // 'sandbox_preview', 'api_key', 'embed'

    ip_address: text("ip_address"),
    user_agent: text("user_agent"),
    country: text("country"), // Derived from IP
    city: text("city"), // Derived from IP

    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    model: text("model"),
    input_tokens: integer("input_tokens").default(0),
    output_tokens: integer("output_tokens").default(0),
    credits_used: numeric("credits_used", { precision: 10, scale: 6 }).default(
      "0.00",
    ),

    response_time_ms: integer("response_time_ms"),
    status: text("status").notNull().default("success"), // 'success', 'failed', 'rate_limited'
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
    app_created_idx: index("app_requests_app_created_idx").on(
      table.app_id,
      table.created_at,
    ),
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
