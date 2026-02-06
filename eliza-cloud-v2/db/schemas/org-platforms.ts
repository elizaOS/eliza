/**
 * Organization Platform Connections Schema
 *
 * Stores Discord, Telegram, and other platform connections
 * for the org app agents to operate across multiple platforms.
 */

import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

// =============================================================================
// ENUMS
// =============================================================================

export const orgPlatformTypeEnum = pgEnum("org_platform_type", [
  "discord",
  "telegram",
  "slack",
  "twitter",
]);

export const orgPlatformStatusEnum = pgEnum("org_platform_status", [
  "active",
  "disconnected",
  "error",
  "pending",
]);

export const orgAgentTypeEnum = pgEnum("org_agent_type", [
  "community_manager",
  "project_manager",
  "dev_rel",
  "liaison",
  "social_media_manager",
]);

// =============================================================================
// PLATFORM CONNECTIONS TABLE
// =============================================================================

/**
 * Stores organization-level platform connections (Discord bots, Telegram bots, etc.)
 */
export const orgPlatformConnections = pgTable(
  "org_platform_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Ownership
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connected_by: uuid("connected_by")
      .notNull()
      .references(() => users.id),

    // Platform info
    platform: orgPlatformTypeEnum("platform").notNull(),
    platform_bot_id: text("platform_bot_id").notNull(), // Bot user ID
    platform_bot_username: text("platform_bot_username"), // @bot_username
    platform_bot_name: text("platform_bot_name"), // Display name

    // Connection status
    status: orgPlatformStatusEnum("status").notNull().default("pending"),
    error_message: text("error_message"),
    last_health_check: timestamp("last_health_check"),

    // OAuth data (for Discord)
    oauth_access_token_secret_id: uuid("oauth_access_token_secret_id"), // Reference to secrets table
    oauth_refresh_token_secret_id: uuid("oauth_refresh_token_secret_id"),
    oauth_expires_at: timestamp("oauth_expires_at"),
    oauth_scopes: jsonb("oauth_scopes").$type<string[]>().default([]),

    // Bot token (for Telegram - stored in secrets)
    bot_token_secret_id: uuid("bot_token_secret_id"), // Reference to secrets table

    // Metadata
    metadata: jsonb("metadata").$type<{
      permissions?: string;
      webhookUrl?: string;
      commandPrefix?: string;
      [key: string]: string | number | boolean | undefined;
    }>(),

    // Timestamps
    connected_at: timestamp("connected_at").notNull().defaultNow(),
    disconnected_at: timestamp("disconnected_at"),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    org_platform_idx: index("org_platform_connections_org_idx").on(
      table.organization_id,
    ),
    platform_idx: index("org_platform_connections_platform_idx").on(
      table.platform,
    ),
    unique_org_platform: uniqueIndex("org_platform_connections_unique").on(
      table.organization_id,
      table.platform,
      table.platform_bot_id,
    ),
    status_idx: index("org_platform_connections_status_idx").on(table.status),
  }),
);

// =============================================================================
// PLATFORM SERVERS/GROUPS TABLE
// =============================================================================

/**
 * Stores individual servers (Discord guilds) or groups (Telegram groups)
 * that are connected to a platform connection.
 */
export const orgPlatformServers = pgTable(
  "org_platform_servers",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Parent connection
    connection_id: uuid("connection_id")
      .notNull()
      .references(() => orgPlatformConnections.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // Server/group info
    server_id: text("server_id").notNull(), // Discord guild ID or Telegram chat ID
    server_name: text("server_name"),
    server_icon: text("server_icon"), // URL to icon
    member_count: text("member_count"), // Approximate member count

    // Configuration
    enabled: boolean("enabled").notNull().default(true),

    // Agent configuration - which agents are active on this server
    enabled_agents: jsonb("enabled_agents")
      .$type<string[]>()
      .default(["community_manager", "project_manager"]),

    // Per-agent settings
    agent_settings: jsonb("agent_settings").$type<{
      community_manager?: {
        greet_new_users?: boolean;
        greeting_channel_id?: string;
        greeting_message?: string;
        timeout_enabled?: boolean;
      };
      project_manager?: {
        checkin_channel_id?: string;
        report_channel_id?: string;
        checkin_frequency?: string;
        checkin_time?: string;
      };
      dev_rel?: {
        support_channel_ids?: string[];
        knowledge_base_enabled?: boolean;
      };
      [key: string]:
        | Record<string, string | boolean | string[] | undefined>
        | undefined;
    }>(),

    // Channel mappings
    channel_mappings: jsonb("channel_mappings").$type<{
      updates?: string; // Channel for posting updates
      checkins?: string; // Channel for check-ins
      reports?: string; // Channel for reports
      support?: string; // Channel for support
      [key: string]: string | undefined;
    }>(),

    // Metadata
    metadata: jsonb("metadata").$type<{
      ownerUserId?: string;
      joinedAt?: string;
      permissions?: string;
      [key: string]: string | undefined;
    }>(),

    // Timestamps
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    connection_idx: index("org_platform_servers_connection_idx").on(
      table.connection_id,
    ),
    org_idx: index("org_platform_servers_org_idx").on(table.organization_id),
    server_id_idx: index("org_platform_servers_server_id_idx").on(
      table.server_id,
    ),
    unique_connection_server: uniqueIndex("org_platform_servers_unique").on(
      table.connection_id,
      table.server_id,
    ),
    enabled_idx: index("org_platform_servers_enabled_idx").on(table.enabled),
  }),
);

// =============================================================================
// TODO ITEMS TABLE
// =============================================================================

export const orgTodoStatusEnum = pgEnum("org_todo_status", [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

export const orgTodoPriorityEnum = pgEnum("org_todo_priority", [
  "low",
  "medium",
  "high",
  "urgent",
]);

/**
 * Todo items that can be created via web UI, Discord, or Telegram
 */
export const orgTodos = pgTable(
  "org_todos",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Ownership
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    created_by_user_id: uuid("created_by_user_id").references(() => users.id),

    // Todo content
    title: text("title").notNull(),
    description: text("description"),
    status: orgTodoStatusEnum("status").notNull().default("pending"),
    priority: orgTodoPriorityEnum("priority").notNull().default("medium"),

    // Assignment
    assignee_platform_id: text("assignee_platform_id"), // Discord/Telegram user ID
    assignee_platform: orgPlatformTypeEnum("assignee_platform"),
    assignee_name: text("assignee_name"), // Display name

    // Due date
    due_date: timestamp("due_date"),

    // Platform source tracking
    source_platform: text("source_platform"), // "web" | "discord" | "telegram"
    source_server_id: text("source_server_id"), // Discord guild or Telegram chat
    source_channel_id: text("source_channel_id"),
    source_message_id: text("source_message_id"), // Original message that created this

    // Tags/categories
    tags: jsonb("tags").$type<string[]>().default([]),

    // Related resources
    related_checkin_id: uuid("related_checkin_id"),
    related_project: text("related_project"),

    // Timestamps
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    completed_at: timestamp("completed_at"),
  },
  (table) => ({
    org_idx: index("org_todos_org_idx").on(table.organization_id),
    status_idx: index("org_todos_status_idx").on(table.status),
    assignee_idx: index("org_todos_assignee_idx").on(
      table.assignee_platform_id,
      table.assignee_platform,
    ),
    due_date_idx: index("org_todos_due_date_idx").on(table.due_date),
    created_by_idx: index("org_todos_created_by_idx").on(
      table.created_by_user_id,
    ),
  }),
);

// =============================================================================
// CHECK-IN SCHEDULES TABLE
// =============================================================================

export const orgCheckinFrequencyEnum = pgEnum("org_checkin_frequency", [
  "daily",
  "weekdays",
  "weekly",
  "bi_weekly",
  "monthly",
]);

export const orgCheckinTypeEnum = pgEnum("org_checkin_type", [
  "standup",
  "sprint",
  "mental_health",
  "project_status",
  "retrospective",
]);

/**
 * Check-in schedules for team coordination
 */
export const orgCheckinSchedules = pgTable(
  "org_checkin_schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Ownership
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    server_id: uuid("server_id")
      .notNull()
      .references(() => orgPlatformServers.id, { onDelete: "cascade" }),

    // Schedule config
    name: text("name").notNull(),
    checkin_type: orgCheckinTypeEnum("checkin_type")
      .notNull()
      .default("standup"),
    frequency: orgCheckinFrequencyEnum("frequency")
      .notNull()
      .default("weekdays"),
    time_utc: text("time_utc").notNull().default("09:00"), // HH:MM in UTC
    timezone: text("timezone").default("UTC"),

    // Channels
    checkin_channel_id: text("checkin_channel_id").notNull(), // Where to send check-in prompts
    report_channel_id: text("report_channel_id"), // Where to post reports

    // Questions/prompts
    questions: jsonb("questions")
      .$type<string[]>()
      .default([
        "What did you accomplish yesterday?",
        "What are you working on today?",
        "Any blockers?",
      ]),

    // Status
    enabled: boolean("enabled").notNull().default(true),
    last_run_at: timestamp("last_run_at"),
    next_run_at: timestamp("next_run_at"),

    // Metadata
    created_by: uuid("created_by").references(() => users.id),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    org_idx: index("org_checkin_schedules_org_idx").on(table.organization_id),
    server_idx: index("org_checkin_schedules_server_idx").on(table.server_id),
    enabled_idx: index("org_checkin_schedules_enabled_idx").on(table.enabled),
    next_run_idx: index("org_checkin_schedules_next_run_idx").on(
      table.next_run_at,
    ),
  }),
);

// =============================================================================
// CHECK-IN RESPONSES TABLE
// =============================================================================

/**
 * Individual check-in responses from team members
 */
export const orgCheckinResponses = pgTable(
  "org_checkin_responses",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Parent schedule
    schedule_id: uuid("schedule_id")
      .notNull()
      .references(() => orgCheckinSchedules.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // Responder info
    responder_platform_id: text("responder_platform_id").notNull(), // Discord/Telegram user ID
    responder_platform: orgPlatformTypeEnum("responder_platform").notNull(),
    responder_name: text("responder_name"),
    responder_avatar: text("responder_avatar"),

    // Response content
    answers: jsonb("answers").$type<Record<string, string>>().notNull(), // question -> answer map

    // Sentiment analysis (optional)
    sentiment_score: text("sentiment_score"), // -1 to 1
    blockers_detected: boolean("blockers_detected").default(false),
    blockers: jsonb("blockers").$type<string[]>().default([]),

    // Source
    source_message_id: text("source_message_id"),
    source_channel_id: text("source_channel_id"),

    // Timestamps
    submitted_at: timestamp("submitted_at").notNull().defaultNow(),
    checkin_date: timestamp("checkin_date").notNull(), // The date this check-in is for
  },
  (table) => ({
    schedule_idx: index("org_checkin_responses_schedule_idx").on(
      table.schedule_id,
    ),
    org_idx: index("org_checkin_responses_org_idx").on(table.organization_id),
    responder_idx: index("org_checkin_responses_responder_idx").on(
      table.responder_platform_id,
      table.responder_platform,
    ),
    date_idx: index("org_checkin_responses_date_idx").on(table.checkin_date),
  }),
);

// =============================================================================
// TEAM MEMBERS TABLE
// =============================================================================

/**
 * Team members tracked across platforms
 */
export const orgTeamMembers = pgTable(
  "org_team_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Ownership
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    server_id: uuid("server_id")
      .notNull()
      .references(() => orgPlatformServers.id, { onDelete: "cascade" }),

    // Member identity
    platform_user_id: text("platform_user_id").notNull(),
    platform: orgPlatformTypeEnum("platform").notNull(),
    display_name: text("display_name"),
    username: text("username"),
    avatar_url: text("avatar_url"),

    // Role/status
    role: text("role"), // "developer", "designer", "manager", etc.
    is_admin: boolean("is_admin").default(false),
    is_active: boolean("is_active").default(true),

    // Availability
    availability: jsonb("availability").$type<{
      timezone?: string;
      workingHours?: { start: string; end: string };
      workingDays?: string[]; // ["monday", "tuesday", ...]
      status?: "available" | "busy" | "away" | "offline";
    }>(),

    // Stats
    total_checkins: text("total_checkins").default("0"),
    last_checkin_at: timestamp("last_checkin_at"),
    checkin_streak: text("checkin_streak").default("0"),

    // Metadata
    metadata:
      jsonb("metadata").$type<Record<string, string | number | boolean>>(),

    // Timestamps
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    org_idx: index("org_team_members_org_idx").on(table.organization_id),
    server_idx: index("org_team_members_server_idx").on(table.server_id),
    platform_user_idx: index("org_team_members_platform_user_idx").on(
      table.platform_user_id,
      table.platform,
    ),
    unique_member: uniqueIndex("org_team_members_unique").on(
      table.server_id,
      table.platform_user_id,
      table.platform,
    ),
  }),
);

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type OrgPlatformConnection = typeof orgPlatformConnections.$inferSelect;
export type NewOrgPlatformConnection =
  typeof orgPlatformConnections.$inferInsert;

export type OrgPlatformServer = typeof orgPlatformServers.$inferSelect;
export type NewOrgPlatformServer = typeof orgPlatformServers.$inferInsert;

export type OrgTodo = typeof orgTodos.$inferSelect;
export type NewOrgTodo = typeof orgTodos.$inferInsert;

export type OrgCheckinSchedule = typeof orgCheckinSchedules.$inferSelect;
export type NewOrgCheckinSchedule = typeof orgCheckinSchedules.$inferInsert;

export type OrgCheckinResponse = typeof orgCheckinResponses.$inferSelect;
export type NewOrgCheckinResponse = typeof orgCheckinResponses.$inferInsert;

export type OrgTeamMember = typeof orgTeamMembers.$inferSelect;
export type NewOrgTeamMember = typeof orgTeamMembers.$inferInsert;
