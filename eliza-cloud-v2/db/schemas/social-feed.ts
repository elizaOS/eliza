/**
 * Social Feed Management Schema
 *
 * Tables for bidirectional social media integration:
 * - Feed configurations for monitoring external platforms
 * - Engagement events from monitored accounts
 * - Reply confirmation workflows
 * - Notification message tracking
 */

import {
  boolean,
  index,
  integer,
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
import { type NotificationChannel } from "@/lib/types/social-media";

export { type NotificationChannel };

// =============================================================================
// ENUMS
// =============================================================================

export const socialEngagementTypeEnum = pgEnum("social_engagement_type", [
  "mention",
  "reply",
  "quote_tweet",
  "repost",
  "like",
  "comment",
  "follow",
]);

export const replyConfirmationStatusEnum = pgEnum("reply_confirmation_status", [
  "pending",
  "confirmed",
  "rejected",
  "expired",
  "sent",
  "failed",
]);

// =============================================================================
// FEED CONFIGURATIONS TABLE
// =============================================================================

/**
 * Configuration for monitoring external social platforms for engagement
 */
export const orgFeedConfigs = pgTable(
  "org_feed_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // Source platform to monitor
    source_platform: text("source_platform").notNull(), // 'twitter', 'bluesky', etc.
    source_account_id: text("source_account_id").notNull(), // Account ID to monitor
    source_username: text("source_username"), // Display username for reference
    credential_id: uuid("credential_id"), // No FK - platform_credentials table may not exist

    // What to monitor
    monitor_mentions: boolean("monitor_mentions").notNull().default(true),
    monitor_replies: boolean("monitor_replies").notNull().default(true),
    monitor_quote_tweets: boolean("monitor_quote_tweets")
      .notNull()
      .default(true),
    monitor_reposts: boolean("monitor_reposts").notNull().default(false),
    monitor_likes: boolean("monitor_likes").notNull().default(false),

    // Notification channels configuration
    notification_channels: jsonb("notification_channels")
      .$type<NotificationChannel[]>()
      .notNull()
      .default([]),

    // Feed settings
    enabled: boolean("enabled").notNull().default(true),
    polling_interval_seconds: integer("polling_interval_seconds")
      .notNull()
      .default(60),
    min_follower_count: integer("min_follower_count"), // Only notify for users with X+ followers
    filter_keywords: jsonb("filter_keywords").$type<string[]>().default([]),
    filter_mode: text("filter_mode").default("include"), // 'include' or 'exclude'

    // Polling state
    last_polled_at: timestamp("last_polled_at", { withTimezone: true }),
    last_seen_id: text("last_seen_id"), // Cursor for pagination
    poll_error_count: integer("poll_error_count").notNull().default(0),
    last_poll_error: text("last_poll_error"),

    // Timestamps
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_by: uuid("created_by").references(() => users.id),
  },
  (table) => ({
    org_idx: index("org_feed_configs_org_idx").on(table.organization_id),
    enabled_idx: index("org_feed_configs_enabled_idx").on(table.enabled),
    platform_idx: index("org_feed_configs_platform_idx").on(
      table.source_platform,
    ),
    unique_feed: uniqueIndex("org_feed_configs_unique").on(
      table.organization_id,
      table.source_platform,
      table.source_account_id,
    ),
  }),
);

// =============================================================================
// SOCIAL ENGAGEMENT EVENTS TABLE
// =============================================================================

/**
 * Tracked engagement events from monitored social accounts
 */
export const socialEngagementEvents = pgTable(
  "social_engagement_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    feed_config_id: uuid("feed_config_id")
      .notNull()
      .references(() => orgFeedConfigs.id, { onDelete: "cascade" }),

    // Event details
    event_type: socialEngagementTypeEnum("event_type").notNull(),
    source_platform: text("source_platform").notNull(),
    source_post_id: text("source_post_id").notNull(),
    source_post_url: text("source_post_url"),

    // Who engaged
    author_id: text("author_id").notNull(),
    author_username: text("author_username"),
    author_display_name: text("author_display_name"),
    author_avatar_url: text("author_avatar_url"),
    author_follower_count: integer("author_follower_count"),
    author_verified: boolean("author_verified").default(false),

    // Original post reference (what they engaged with)
    original_post_id: text("original_post_id"),
    original_post_url: text("original_post_url"),
    original_post_content: text("original_post_content"),

    // Engagement content
    content: text("content"),
    content_html: text("content_html"), // Formatted version with links/mentions
    media_urls: jsonb("media_urls").$type<string[]>().default([]),

    // Processing state
    processed_at: timestamp("processed_at", { withTimezone: true }),
    notification_sent_at: timestamp("notification_sent_at", {
      withTimezone: true,
    }),
    notification_channel_ids: jsonb("notification_channel_ids")
      .$type<string[]>()
      .default([]),
    notification_message_ids: jsonb("notification_message_ids")
      .$type<Record<string, string>>()
      .default({}), // platform -> messageId

    // Metadata
    raw_data: jsonb("raw_data").$type<Record<string, unknown>>(),
    engagement_metrics: jsonb("engagement_metrics").$type<{
      likes?: number;
      reposts?: number;
      replies?: number;
      quotes?: number;
    }>(),

    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    org_idx: index("social_engagement_events_org_idx").on(
      table.organization_id,
    ),
    feed_idx: index("social_engagement_events_feed_idx").on(
      table.feed_config_id,
    ),
    type_idx: index("social_engagement_events_type_idx").on(table.event_type),
    created_idx: index("social_engagement_events_created_idx").on(
      table.created_at,
    ),
    author_idx: index("social_engagement_events_author_idx").on(
      table.author_id,
    ),
    unique_event: uniqueIndex("social_engagement_events_unique").on(
      table.feed_config_id,
      table.source_post_id,
    ),
  }),
);

// =============================================================================
// PENDING REPLY CONFIRMATIONS TABLE
// =============================================================================

/**
 * Pending reply confirmations waiting for user approval
 */
export const pendingReplyConfirmations = pgTable(
  "pending_reply_confirmations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // What we're replying to
    engagement_event_id: uuid("engagement_event_id").references(
      () => socialEngagementEvents.id,
      { onDelete: "set null" },
    ),
    target_platform: text("target_platform").notNull(), // Platform to post reply to
    target_post_id: text("target_post_id").notNull(), // Post ID to reply to
    target_post_url: text("target_post_url"),

    // Where the reply came from
    source_platform: text("source_platform").notNull(), // 'discord', 'telegram', 'slack'
    source_channel_id: text("source_channel_id").notNull(),
    source_server_id: text("source_server_id"), // For Discord/Slack
    source_message_id: text("source_message_id").notNull(),
    source_user_id: text("source_user_id").notNull(),
    source_username: text("source_username"),
    source_user_display_name: text("source_user_display_name"),

    // The proposed reply
    reply_content: text("reply_content").notNull(),
    reply_media_urls: jsonb("reply_media_urls").$type<string[]>().default([]),

    // Confirmation state
    status: replyConfirmationStatusEnum("status").notNull().default("pending"),
    confirmation_message_id: text("confirmation_message_id"), // Message ID of confirmation prompt
    confirmation_channel_id: text("confirmation_channel_id"), // Where confirmation was sent

    // Approval details
    confirmed_by_user_id: text("confirmed_by_user_id"),
    confirmed_by_username: text("confirmed_by_username"),
    confirmed_at: timestamp("confirmed_at", { withTimezone: true }),
    rejection_reason: text("rejection_reason"),

    // Result
    sent_post_id: text("sent_post_id"),
    sent_post_url: text("sent_post_url"),
    sent_at: timestamp("sent_at", { withTimezone: true }),
    error_message: text("error_message"),
    retry_count: integer("retry_count").notNull().default(0),

    // Timing
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    org_idx: index("pending_reply_confirmations_org_idx").on(
      table.organization_id,
    ),
    status_idx: index("pending_reply_confirmations_status_idx").on(
      table.status,
    ),
    engagement_idx: index("pending_reply_confirmations_engagement_idx").on(
      table.engagement_event_id,
    ),
    source_msg_idx: index("pending_reply_confirmations_source_msg_idx").on(
      table.source_platform,
      table.source_channel_id,
      table.source_message_id,
    ),
  }),
);

// =============================================================================
// NOTIFICATION MESSAGE TRACKING TABLE
// =============================================================================

/**
 * Tracks notification messages for reply detection
 */
export const socialNotificationMessages = pgTable(
  "social_notification_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    engagement_event_id: uuid("engagement_event_id")
      .notNull()
      .references(() => socialEngagementEvents.id, { onDelete: "cascade" }),

    // Where notification was sent
    platform: text("platform").notNull(), // 'discord', 'telegram', 'slack'
    channel_id: text("channel_id").notNull(),
    server_id: text("server_id"), // For Discord/Slack
    message_id: text("message_id").notNull(),

    // For thread tracking
    thread_id: text("thread_id"), // Thread/topic ID if applicable

    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    org_idx: index("social_notification_messages_org_idx").on(
      table.organization_id,
    ),
    engagement_idx: index("social_notification_messages_engagement_idx").on(
      table.engagement_event_id,
    ),
    lookup_idx: index("social_notification_messages_lookup_idx").on(
      table.platform,
      table.channel_id,
      table.message_id,
    ),
    unique_msg: uniqueIndex("social_notification_messages_unique").on(
      table.engagement_event_id,
      table.platform,
      table.channel_id,
      table.message_id,
    ),
  }),
);

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type OrgFeedConfig = typeof orgFeedConfigs.$inferSelect;
export type NewOrgFeedConfig = typeof orgFeedConfigs.$inferInsert;

export type SocialEngagementEvent = typeof socialEngagementEvents.$inferSelect;
export type NewSocialEngagementEvent =
  typeof socialEngagementEvents.$inferInsert;

export type PendingReplyConfirmation =
  typeof pendingReplyConfirmations.$inferSelect;
export type NewPendingReplyConfirmation =
  typeof pendingReplyConfirmations.$inferInsert;

export type SocialNotificationMessage =
  typeof socialNotificationMessages.$inferSelect;
export type NewSocialNotificationMessage =
  typeof socialNotificationMessages.$inferInsert;

export type SocialEngagementType =
  | "mention"
  | "reply"
  | "quote_tweet"
  | "repost"
  | "like"
  | "comment"
  | "follow";

export type ReplyConfirmationStatus =
  | "pending"
  | "confirmed"
  | "rejected"
  | "expired"
  | "sent"
  | "failed";
