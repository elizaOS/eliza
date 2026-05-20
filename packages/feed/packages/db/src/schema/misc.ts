import { desc, relations } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  json,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "../types";
import {
  realtimeOutboxStatusEnum,
  sentryIncidentAlertOutboxStatusEnum,
  sentryIncidentRunDecisionEnum,
  sentryIncidentRunStatusEnum,
  sentryWebhookInboxStatusEnum,
} from "./enums";

// Game
export const games = pgTable(
  "Game",
  {
    id: text("id").primaryKey(),
    currentDay: integer("currentDay").notNull().default(1),
    currentDate: timestamp("currentDate", { mode: "date" })
      .notNull()
      .defaultNow(),
    isRunning: boolean("isRunning").notNull().default(false),
    isContinuous: boolean("isContinuous").notNull().default(true),
    speed: integer("speed").notNull().default(60000),
    startedAt: timestamp("startedAt", { mode: "date" }),
    pausedAt: timestamp("pausedAt", { mode: "date" }),
    completedAt: timestamp("completedAt", { mode: "date" }),
    lastTickAt: timestamp("lastTickAt", { mode: "date" }),
    lastSnapshotAt: timestamp("lastSnapshotAt", { mode: "date" }),
    activeQuestions: integer("activeQuestions").notNull().default(0),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("Game_isContinuous_idx").on(table.isContinuous),
    index("Game_isRunning_idx").on(table.isRunning),
  ],
);

// GameConfig
export const gameConfigs = pgTable(
  "GameConfig",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(),
    value: json("value").$type<JsonValue>().notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [index("GameConfig_key_idx").on(table.key)],
);

// RealtimeOutbox
export const realtimeOutboxes = pgTable(
  "RealtimeOutbox",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    type: text("type").notNull(),
    version: text("version").default("v1"),
    payload: json("payload").$type<JsonValue>().notNull(),
    status: realtimeOutboxStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("lastError"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("RealtimeOutbox_status_createdAt_idx").on(
      table.status,
      table.createdAt,
    ),
    index("RealtimeOutbox_channel_status_idx").on(table.channel, table.status),
  ],
);

// SentryWebhookInbox
export const sentryWebhookInboxes = pgTable(
  "SentryWebhookInbox",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull().default("sentry"),
    resource: text("resource").notNull(),
    action: text("action"),
    organizationSlug: text("organizationSlug"),
    projectSlug: text("projectSlug"),
    issueId: text("issueId"),
    issueShortId: text("issueShortId"),
    issueTitle: text("issueTitle"),
    issueUrl: text("issueUrl"),
    eventId: text("eventId"),
    level: text("level"),
    culprit: text("culprit"),
    dedupeKey: text("dedupeKey").notNull().unique(),
    routingKey: text("routingKey"),
    webhookTimestamp: timestamp("webhookTimestamp", { mode: "date" }),
    status: sentryWebhookInboxStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("maxAttempts").notNull().default(8),
    nextAttemptAt: timestamp("nextAttemptAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    processingStartedAt: timestamp("processingStartedAt", { mode: "date" }),
    processedAt: timestamp("processedAt", { mode: "date" }),
    failedAt: timestamp("failedAt", { mode: "date" }),
    lastError: text("lastError"),
    payload: json("payload").$type<JsonValue>().notNull(),
    metadata: json("metadata").$type<JsonValue>(),
    receivedAt: timestamp("receivedAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("SentryWebhookInbox_status_nextAttemptAt_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    index("SentryWebhookInbox_project_issue_status_idx").on(
      table.projectSlug,
      table.issueId,
      table.status,
    ),
    index("SentryWebhookInbox_eventId_idx").on(table.eventId),
    index("SentryWebhookInbox_routingKey_status_idx").on(
      table.routingKey,
      table.status,
    ),
    index("SentryWebhookInbox_receivedAt_idx").on(table.receivedAt),
    index("SentryWebhookInbox_resource_action_idx").on(
      table.resource,
      table.action,
    ),
  ],
);

// SentryIncidentRun
export const sentryIncidentRuns = pgTable(
  "SentryIncidentRun",
  {
    id: text("id").primaryKey(),
    inboxId: text("inboxId").notNull(),
    sentryIssueKey: text("sentryIssueKey").notNull(),
    issueId: text("issueId"),
    issueShortId: text("issueShortId"),
    action: text("action"),
    workerId: text("workerId").notNull(),
    status: sentryIncidentRunStatusEnum("status").notNull().default("running"),
    decision: sentryIncidentRunDecisionEnum("decision")
      .notNull()
      .default("pending"),
    linearIssueId: text("linearIssueId"),
    linearIssueUrl: text("linearIssueUrl"),
    codexSessionId: text("codexSessionId"),
    summary: text("summary"),
    resultReason: text("resultReason"),
    error: text("error"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    finishedAt: timestamp("finishedAt", { mode: "date" }),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("SentryIncidentRun_inboxId_idx").on(table.inboxId),
    index("SentryIncidentRun_issueKey_createdAt_idx").on(
      table.sentryIssueKey,
      table.createdAt,
    ),
    index("SentryIncidentRun_linearIssueId_idx").on(table.linearIssueId),
    index("SentryIncidentRun_status_createdAt_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const sentryIncidentAlertOutboxes = pgTable(
  "SentryIncidentAlertOutbox",
  {
    id: text("id").primaryKey(),
    runId: text("runId"),
    inboxId: text("inboxId").notNull(),
    sentryIssueKey: text("sentryIssueKey").notNull(),
    eventType: text("eventType").notNull(),
    dedupeKey: text("dedupeKey").notNull().unique(),
    payload: json("payload").$type<JsonValue>().notNull(),
    status: sentryIncidentAlertOutboxStatusEnum("status")
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("maxAttempts").notNull().default(8),
    nextAttemptAt: timestamp("nextAttemptAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    processingStartedAt: timestamp("processingStartedAt", { mode: "date" }),
    sentAt: timestamp("sentAt", { mode: "date" }),
    lastError: text("lastError"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("SentryIncidentAlertOutbox_status_nextAttemptAt_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    index("SentryIncidentAlertOutbox_issueKey_createdAt_idx").on(
      table.sentryIssueKey,
      table.createdAt,
    ),
    index("SentryIncidentAlertOutbox_runId_idx").on(table.runId),
    index("SentryIncidentAlertOutbox_inboxId_idx").on(table.inboxId),
  ],
);

export const sentryIncidentDiscordThreads = pgTable(
  "SentryIncidentDiscordThread",
  {
    id: text("id").primaryKey(),
    sentryIssueKey: text("sentryIssueKey").notNull().unique(),
    channelId: text("channelId").notNull(),
    rootMessageId: text("rootMessageId").notNull(),
    threadId: text("threadId").notNull().unique(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("SentryIncidentDiscordThread_threadId_idx").on(table.threadId),
  ],
);

// OAuthState
export const oAuthStates = pgTable(
  "OAuthState",
  {
    id: text("id").primaryKey(),
    state: text("state").notNull().unique(),
    codeVerifier: text("codeVerifier").notNull(),
    userId: text("userId"),
    returnPath: text("returnPath"),
    expiresAt: timestamp("expiresAt", { mode: "date" }).notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("OAuthState_expiresAt_idx").on(table.expiresAt),
    index("OAuthState_state_idx").on(table.state),
  ],
);

// WidgetCache
export const widgetCaches = pgTable(
  "WidgetCache",
  {
    widget: text("widget").primaryKey(),
    data: json("data").$type<JsonValue>().notNull(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("WidgetCache_widget_updatedAt_idx").on(table.widget, table.updatedAt),
  ],
);

// WorldEvent
export const worldEvents = pgTable(
  "WorldEvent",
  {
    id: text("id").primaryKey(),
    eventType: text("eventType").notNull(),
    description: text("description").notNull(),
    actors: text("actors").array().notNull().default([]),
    relatedQuestion: integer("relatedQuestion"),
    pointsToward: text("pointsToward"),
    visibility: text("visibility").notNull().default("public"),
    gameId: text("gameId"),
    dayNumber: integer("dayNumber"),
    timestamp: timestamp("timestamp", { mode: "date" }).notNull().defaultNow(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("WorldEvent_gameId_dayNumber_idx").on(table.gameId, table.dayNumber),
    index("WorldEvent_relatedQuestion_idx").on(table.relatedQuestion),
    index("WorldEvent_timestamp_idx").on(table.timestamp),
  ],
);

/**
 * WorldFact — persistent world-state context for generation prompts.
 *
 * generationDepth ladder:
 *   0 = human-authored or RSS-sourced (seed data, manual entries)
 *   1 = first-generation LLM output (auto-generated facts, consolidated facts)
 *   2+ = derived from LLM output (not currently produced; reserved)
 *
 * Read-side filter: lte(generationDepth, 1) — depth ≥ 2 is excluded from
 * prompt context to structurally prevent recursive amplification.
 *
 * qualityScore: nullable float 0–1. Pre-migration records are NULL and
 * treated as presumed-OK by read-side filter:
 *   or(isNull(qualityScore), gte(qualityScore, MIN_QUALITY_SCORE))
 */
export const worldFacts = pgTable(
  "WorldFact",
  {
    id: text("id").primaryKey(),
    category: text("category").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    value: text("value").notNull(),
    source: text("source"),
    lastUpdated: timestamp("lastUpdated", { mode: "date" }).notNull(),
    isActive: boolean("isActive").notNull().default(true),
    priority: integer("priority").notNull().default(0),
    qualityScore: doublePrecision("qualityScore"),
    generationDepth: integer("generationDepth").notNull().default(0),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("WorldFact_category_isActive_idx").on(table.category, table.isActive),
    index("WorldFact_priority_idx").on(table.priority),
    index("WorldFact_lastUpdated_idx").on(table.lastUpdated),
    index("WorldFact_source_createdAt_idx").on(
      table.source,
      desc(table.createdAt),
    ),
  ],
);

// SystemSettings
export const systemSettings = pgTable("SystemSettings", {
  id: text("id").primaryKey().default("system"),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
});

// GenerationLock
export const generationLocks = pgTable(
  "GenerationLock",
  {
    id: text("id").primaryKey().default("game-tick-lock"),
    lockedBy: text("lockedBy").notNull(),
    lockedAt: timestamp("lockedAt", { mode: "date" }).notNull().defaultNow(),
    expiresAt: timestamp("expiresAt", { mode: "date" }).notNull(),
    operation: text("operation").notNull().default("game-tick"),
  },
  (table) => [index("GenerationLock_expiresAt_idx").on(table.expiresAt)],
);

// RSSFeedSource
export const rssFeedSources = pgTable(
  "RSSFeedSource",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    feedUrl: text("feedUrl").notNull(),
    category: text("category").notNull(),
    isActive: boolean("isActive").notNull().default(true),
    lastFetched: timestamp("lastFetched", { mode: "date" }),
    fetchErrors: integer("fetchErrors").notNull().default(0),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("RSSFeedSource_isActive_lastFetched_idx").on(
      table.isActive,
      table.lastFetched,
    ),
    index("RSSFeedSource_category_idx").on(table.category),
  ],
);

// RSSHeadline
export const rssHeadlines = pgTable(
  "RSSHeadline",
  {
    id: text("id").primaryKey(),
    sourceId: text("sourceId").notNull(),
    title: text("title").notNull(),
    link: text("link"),
    publishedAt: timestamp("publishedAt", { mode: "date" }).notNull(),
    summary: text("summary"),
    content: text("content"),
    rawData: json("rawData").$type<JsonValue>(),
    fetchedAt: timestamp("fetchedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("RSSHeadline_sourceId_publishedAt_idx").on(
      table.sourceId,
      table.publishedAt,
    ),
    index("RSSHeadline_publishedAt_idx").on(table.publishedAt),
  ],
);

// ParodyHeadline
/**
 * ParodyHeadline — satirical rewrites of RSS headlines.
 *
 * generationDepth: 0 = direct LLM parody of an RSS headline (current default).
 * qualityScore + qualityReasons: populated by ContentQualityGate.validateParody().
 * Read-side filter mirrors WorldFact: nullable scores presumed OK.
 */
export const parodyHeadlines = pgTable(
  "ParodyHeadline",
  {
    id: text("id").primaryKey(),
    originalHeadlineId: text("originalHeadlineId").notNull().unique(),
    originalTitle: text("originalTitle").notNull(),
    originalSource: text("originalSource").notNull(),
    parodyTitle: text("parodyTitle").notNull(),
    parodyContent: text("parodyContent"),
    characterMappings: json("characterMappings").$type<JsonValue>().notNull(),
    organizationMappings: json("organizationMappings")
      .$type<JsonValue>()
      .notNull(),
    generatedAt: timestamp("generatedAt", { mode: "date" }).notNull(),
    isUsed: boolean("isUsed").notNull().default(false),
    usedAt: timestamp("usedAt", { mode: "date" }),
    qualityScore: doublePrecision("qualityScore"),
    qualityReasons: json("qualityReasons").$type<string[]>(),
    generationDepth: integer("generationDepth").notNull().default(0),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("ParodyHeadline_isUsed_generatedAt_idx").on(
      table.isUsed,
      table.generatedAt,
    ),
    index("ParodyHeadline_generatedAt_idx").on(table.generatedAt),
  ],
);

export type DailyTopicSourceType =
  | "auto"
  | "manual_override"
  | "fallback_previous_day"
  | "fallback_default";

// DailyTopic - The single narrative topic that should drive new gameplay for a day
export const dailyTopics = pgTable(
  "DailyTopic",
  {
    id: text("id").primaryKey(),
    date: timestamp("date", { mode: "date" }).notNull().unique(),
    topicKey: text("topicKey").notNull(),
    topicLabel: text("topicLabel").notNull(),
    summary: text("summary").notNull(),
    sourceType: text("sourceType").$type<DailyTopicSourceType>().notNull(),
    sourceHeadlineIds: json("sourceHeadlineIds").$type<string[]>().notNull(),
    selectionReason: text("selectionReason"),
    isLocked: boolean("isLocked").notNull().default(false),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("DailyTopic_date_idx").on(table.date),
    index("DailyTopic_topicKey_idx").on(table.topicKey),
    index("DailyTopic_isLocked_date_idx").on(table.isLocked, table.date),
  ],
);

// TickTokenStats - Stores LLM token usage statistics per game tick
export const tickTokenStats = pgTable(
  "TickTokenStats",
  {
    id: text("id").primaryKey(),
    tickId: text("tickId").notNull(),
    tickStartedAt: timestamp("tickStartedAt", { mode: "date" }).notNull(),
    tickCompletedAt: timestamp("tickCompletedAt", { mode: "date" }).notNull(),
    tickDurationMs: integer("tickDurationMs").notNull(),
    totalCalls: integer("totalCalls").notNull(),
    totalInputTokens: integer("totalInputTokens").notNull(),
    totalOutputTokens: integer("totalOutputTokens").notNull(),
    totalTokens: integer("totalTokens").notNull(),
    byPromptType: json("byPromptType").$type<JsonValue>().notNull(),
    byModel: json("byModel").$type<JsonValue>().notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("TickTokenStats_tickStartedAt_idx").on(table.tickStartedAt),
    index("TickTokenStats_tickId_idx").on(table.tickId),
    index("TickTokenStats_createdAt_idx").on(table.createdAt),
  ],
);

// Relations
export const rssFeedSourcesRelations = relations(
  rssFeedSources,
  ({ many }) => ({
    headlines: many(rssHeadlines),
  }),
);

export const rssHeadlinesRelations = relations(rssHeadlines, ({ one }) => ({
  source: one(rssFeedSources, {
    fields: [rssHeadlines.sourceId],
    references: [rssFeedSources.id],
  }),
  parodyHeadline: one(parodyHeadlines, {
    fields: [rssHeadlines.id],
    references: [parodyHeadlines.originalHeadlineId],
  }),
}));

export const parodyHeadlinesRelations = relations(
  parodyHeadlines,
  ({ one }) => ({
    originalHeadline: one(rssHeadlines, {
      fields: [parodyHeadlines.originalHeadlineId],
      references: [rssHeadlines.id],
    }),
  }),
);

export const dailyTopicsRelations = relations(dailyTopics, () => ({}));

// AdminAuditLog - Stores audit trail for all admin actions
export const adminAuditLogs = pgTable(
  "AdminAuditLog",
  {
    id: text("id").primaryKey(),
    adminId: text("adminId").notNull(),
    action: text("action").notNull(),
    resourceType: text("resourceType").notNull(),
    resourceId: text("resourceId"),
    previousValue: json("previousValue").$type<JsonValue>(),
    newValue: json("newValue").$type<JsonValue>(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    metadata: json("metadata").$type<JsonValue>(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("AdminAuditLog_adminId_idx").on(table.adminId),
    index("AdminAuditLog_action_idx").on(table.action),
    index("AdminAuditLog_resourceType_idx").on(table.resourceType),
    index("AdminAuditLog_resourceId_idx").on(table.resourceId),
    index("AdminAuditLog_createdAt_idx").on(table.createdAt),
    index("AdminAuditLog_adminId_createdAt_idx").on(
      table.adminId,
      table.createdAt,
    ),
  ],
);

// AnalyticsDailySnapshot - Stores daily analytics snapshots for the admin dashboard
export const analyticsDailySnapshots = pgTable(
  "AnalyticsDailySnapshot",
  {
    id: text("id").primaryKey(),
    date: timestamp("date", { mode: "date" }).notNull().unique(),
    // User metrics
    totalUsers: integer("totalUsers").notNull().default(0),
    newUsers: integer("newUsers").notNull().default(0),
    activeUsers: integer("activeUsers").notNull().default(0),
    bannedUsers: integer("bannedUsers").notNull().default(0),
    // Social metrics
    totalPosts: integer("totalPosts").notNull().default(0),
    newPosts: integer("newPosts").notNull().default(0),
    totalComments: integer("totalComments").notNull().default(0),
    newComments: integer("newComments").notNull().default(0),
    totalReactions: integer("totalReactions").notNull().default(0),
    newReactions: integer("newReactions").notNull().default(0),
    // Trading metrics
    totalMarkets: integer("totalMarkets").notNull().default(0),
    activeMarkets: integer("activeMarkets").notNull().default(0),
    totalTrades: integer("totalTrades").notNull().default(0),
    newTrades: integer("newTrades").notNull().default(0),
    // Engagement metrics
    totalFollows: integer("totalFollows").notNull().default(0),
    newFollows: integer("newFollows").notNull().default(0),
    totalReferrals: integer("totalReferrals").notNull().default(0),
    newReferrals: integer("newReferrals").notNull().default(0),
    // Moderation metrics
    totalReports: integer("totalReports").notNull().default(0),
    newReports: integer("newReports").notNull().default(0),
    resolvedReports: integer("resolvedReports").notNull().default(0),
    // Additional data as JSON
    metadata: json("metadata").$type<JsonValue>(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("AnalyticsDailySnapshot_date_idx").on(table.date),
    index("AnalyticsDailySnapshot_createdAt_idx").on(table.createdAt),
  ],
);

// Type exports
export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
export type GameConfig = typeof gameConfigs.$inferSelect;
export type NewGameConfig = typeof gameConfigs.$inferInsert;
export type RealtimeOutbox = typeof realtimeOutboxes.$inferSelect;
export type NewRealtimeOutbox = typeof realtimeOutboxes.$inferInsert;
export type SentryWebhookInbox = typeof sentryWebhookInboxes.$inferSelect;
export type NewSentryWebhookInbox = typeof sentryWebhookInboxes.$inferInsert;
export type SentryIncidentRun = typeof sentryIncidentRuns.$inferSelect;
export type NewSentryIncidentRun = typeof sentryIncidentRuns.$inferInsert;
export type SentryIncidentAlertOutbox =
  typeof sentryIncidentAlertOutboxes.$inferSelect;
export type NewSentryIncidentAlertOutbox =
  typeof sentryIncidentAlertOutboxes.$inferInsert;
export type SentryIncidentDiscordThread =
  typeof sentryIncidentDiscordThreads.$inferSelect;
export type NewSentryIncidentDiscordThread =
  typeof sentryIncidentDiscordThreads.$inferInsert;
export type OAuthState = typeof oAuthStates.$inferSelect;
export type NewOAuthState = typeof oAuthStates.$inferInsert;
export type WidgetCache = typeof widgetCaches.$inferSelect;
export type NewWidgetCache = typeof widgetCaches.$inferInsert;
export type WorldEvent = typeof worldEvents.$inferSelect;
export type NewWorldEvent = typeof worldEvents.$inferInsert;
export type WorldFact = typeof worldFacts.$inferSelect;
export type NewWorldFact = typeof worldFacts.$inferInsert;
export type SystemSettings = typeof systemSettings.$inferSelect;
export type NewSystemSettings = typeof systemSettings.$inferInsert;
export type GenerationLock = typeof generationLocks.$inferSelect;
export type NewGenerationLock = typeof generationLocks.$inferInsert;
export type RSSFeedSource = typeof rssFeedSources.$inferSelect;
export type NewRSSFeedSource = typeof rssFeedSources.$inferInsert;
export type RSSHeadline = typeof rssHeadlines.$inferSelect;
export type NewRSSHeadline = typeof rssHeadlines.$inferInsert;
export type DailyTopic = typeof dailyTopics.$inferSelect;
export type NewDailyTopic = typeof dailyTopics.$inferInsert;
export type ParodyHeadline = typeof parodyHeadlines.$inferSelect;
export type NewParodyHeadline = typeof parodyHeadlines.$inferInsert;
export type TickTokenStatsRow = typeof tickTokenStats.$inferSelect;
export type NewTickTokenStatsRow = typeof tickTokenStats.$inferInsert;
export type AdminAuditLog = typeof adminAuditLogs.$inferSelect;
export type NewAdminAuditLog = typeof adminAuditLogs.$inferInsert;
export type AnalyticsDailySnapshot =
  typeof analyticsDailySnapshots.$inferSelect;
export type NewAnalyticsDailySnapshot =
  typeof analyticsDailySnapshots.$inferInsert;
