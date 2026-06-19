import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Moderation action enum
 */
export const moderationActionEnum = pgEnum("moderation_action", [
  "refused", // Message was refused (first offense)
  "warned", // User was warned (2+ offenses)
  "flagged_for_ban", // User flagged for admin review (5+ offenses)
  "banned", // User was banned by admin
]);

/**
 * User status enum for moderation
 */
export const userModerationStatusEnum = pgEnum("user_mod_status", [
  "clean", // No issues
  "warned", // Has violations but not banned
  "spammer", // Marked as spammer
  "scammer", // Marked as scammer
  "banned", // Banned from platform
]);

/**
 * Moderation violations table schema.
 *
 * Stores all content moderation violations for tracking and admin review.
 */
export const moderationViolations = pgTable(
  "moderation_violations",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // User who violated
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Context
    roomId: text("room_id"),
    messageText: text("message_text").notNull(), // Truncated to 500 chars

    // Violation details
    categories: jsonb("categories").notNull().$type<string[]>(), // ["sexual/minors", "self-harm"]
    scores: jsonb("scores").notNull().$type<Record<string, number>>(),
    action: moderationActionEnum("action").notNull(),

    // Admin review
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at"),
    reviewNotes: text("review_notes"),

    // Lifecycle
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index("moderation_violations_user_id_idx").on(table.userId),
    actionIdx: index("moderation_violations_action_idx").on(table.action),
    createdAtIdx: index("moderation_violations_created_at_idx").on(table.createdAt),
    roomIdIdx: index("moderation_violations_room_id_idx").on(table.roomId),
  }),
);

/**
 * User moderation status table.
 *
 * Stores the overall moderation status for users (spammer, scammer, banned, etc.)
 */
export const userModerationStatus = pgTable(
  "user_moderation_status",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),

    // Status
    status: userModerationStatusEnum("status").notNull().default("clean"),

    // Violation counts
    totalViolations: integer("total_violations").notNull().default(0),
    warningCount: integer("warning_count").notNull().default(0),

    // Risk score (0-100)
    riskScore: real("risk_score").notNull().default(0),

    // Admin actions
    bannedBy: uuid("banned_by").references(() => users.id),
    bannedAt: timestamp("banned_at"),
    banReason: text("ban_reason"),

    // Last action
    lastViolationAt: timestamp("last_violation_at"),
    lastWarningAt: timestamp("last_warning_at"),

    // Lifecycle
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index("user_moderation_status_user_id_idx").on(table.userId),
    statusIdx: index("user_moderation_status_status_idx").on(table.status),
    riskScoreIdx: index("user_moderation_status_risk_score_idx").on(table.riskScore),
    totalViolationsIdx: index("user_moderation_status_total_violations_idx").on(
      table.totalViolations,
    ),
  }),
);

export type ModerationViolation = InferSelectModel<typeof moderationViolations>;
export type NewModerationViolation = InferInsertModel<typeof moderationViolations>;

export type UserModerationStatus = InferSelectModel<typeof userModerationStatus>;
export type NewUserModerationStatus = InferInsertModel<typeof userModerationStatus>;
