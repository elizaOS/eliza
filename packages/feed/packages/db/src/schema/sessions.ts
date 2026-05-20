/**
 * Session Tracking Schema
 *
 * Tracks user sessions for engagement metrics:
 * - UserSession: Individual session records with start/end times
 * - Used for calculating sessions per WAU, median session length
 *
 * @module sessions
 */

import { relations } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * UserSession - Tracks individual user sessions
 *
 * A session is a continuous period of activity. A new session starts
 * after 30+ minutes of inactivity. Sessions are tracked via client-side
 * heartbeat that pings every 5 minutes.
 *
 * Session lifecycle:
 * 1. First heartbeat creates session with startedAt = now
 * 2. Subsequent heartbeats update lastActiveAt
 * 3. If no heartbeat for 30+ minutes, session is considered ended
 * 4. endedAt is set by cleanup job or next session creation
 */
export const userSessions = pgTable(
  "UserSession",
  {
    id: text("id").primaryKey(),

    // User who owns this session
    userId: text("userId").notNull(),

    // Client-generated UUID to handle concurrent tabs
    // Stored in sessionStorage, unique per browser tab
    sessionId: text("sessionId").notNull(),

    // Session timing
    startedAt: timestamp("startedAt", { mode: "date" }).notNull(),
    lastActiveAt: timestamp("lastActiveAt", { mode: "date" }).notNull(),
    endedAt: timestamp("endedAt", { mode: "date" }), // NULL = ongoing session

    // Optional device information (hashed/anonymized)
    deviceType: text("deviceType"), // 'desktop', 'mobile', 'tablet'
    userAgent: text("userAgent"),
    ipHash: text("ipHash"), // SHA-256 hash for privacy

    // Activity counters
    pageCount: integer("pageCount").notNull().default(0),
    heartbeatCount: integer("heartbeatCount").notNull().default(1),

    // Timestamps
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // Find sessions by user
    index("UserSession_userId_startedAt_idx").on(table.userId, table.startedAt),

    // Find active sessions (endedAt is null)
    index("UserSession_userId_endedAt_idx").on(table.userId, table.endedAt),

    // Find sessions by time range
    index("UserSession_startedAt_idx").on(table.startedAt),

    // Find sessions to close (lastActiveAt older than threshold)
    index("UserSession_lastActiveAt_idx").on(table.lastActiveAt),

    // Index for looking up active sessions by sessionId (for heartbeat updates)
    // Note: sessionId is client-generated UUID stored in sessionStorage per browser tab.
    // Same sessionId can have multiple sessions (one active, many ended) as sessions
    // expire and restart. We look up by sessionId + endedAt IS NULL in the handler.
    index("UserSession_sessionId_idx").on(table.sessionId),
  ],
);

// Relations
export const userSessionsRelations = relations(userSessions, ({ one }) => ({
  user: one(users, {
    fields: [userSessions.userId],
    references: [users.id],
  }),
}));

// Type exports
export type UserSession = typeof userSessions.$inferSelect;
export type NewUserSession = typeof userSessions.$inferInsert;

/**
 * UserActivityLog - Lightweight activity log for retention cohorts
 *
 * Stores one row per user per activity type per day.
 * Used for efficient D7 retention calculations without
 * scanning large activity tables.
 */
export const userActivityLogs = pgTable(
  "UserActivityLog",
  {
    id: text("id").primaryKey(),

    userId: text("userId").notNull(),

    // Activity type: trade, post, comment, message, reaction, login, session
    activityType: text("activityType").notNull(),

    // Truncated to day for efficient cohort queries
    activityDate: timestamp("activityDate", { mode: "date" }).notNull(),

    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // Unique: one row per user per activity type per day
    unique("UserActivityLog_userId_activityDate_activityType_idx").on(
      table.userId,
      table.activityDate,
      table.activityType,
    ),

    // Find all activity on a date (for cohort calculations)
    index("UserActivityLog_activityDate_idx").on(table.activityDate),

    // Find user's activity history
    index("UserActivityLog_userId_activityDate_idx").on(
      table.userId,
      table.activityDate,
    ),
    // Lifetime counts by activity type (no activityDate in predicate)
    index("UserActivityLog_userId_activityType_idx").on(
      table.userId,
      table.activityType,
    ),
  ],
);

// Relations
export const userActivityLogsRelations = relations(
  userActivityLogs,
  ({ one }) => ({
    user: one(users, {
      fields: [userActivityLogs.userId],
      references: [users.id],
    }),
  }),
);

// Type exports
export type UserActivityLog = typeof userActivityLogs.$inferSelect;
export type NewUserActivityLog = typeof userActivityLogs.$inferInsert;

/**
 * TradeAttempt - Logs all trade attempts including failures
 *
 * Used for calculating trade success rate. Separate from
 * BalanceTransaction which only logs successful trades.
 */
export const tradeAttempts = pgTable(
  "TradeAttempt",
  {
    id: text("id").primaryKey(),

    userId: text("userId").notNull(),

    // Trade type from FEE_CONFIG.FEE_TYPES
    tradeType: text("tradeType").notNull(), // 'pred_buy', 'pred_sell', 'perp_open', 'perp_close'

    // Context
    marketId: text("marketId"), // For prediction markets
    ticker: text("ticker"), // For perpetuals

    // Amount attempted
    amount: text("amount").notNull(), // Stored as text for precision

    // Outcome
    outcome: text("outcome").notNull(), // 'success', 'failed', 'rejected'
    failureReason: text("failureReason"), // Human-readable error message
    failureCode: text("failureCode"), // Machine-readable code for categorization

    // Performance
    durationMs: integer("durationMs"), // Time from attempt start to completion
    requestId: text("requestId"), // Correlation ID for debugging

    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // Find attempts by user
    index("TradeAttempt_userId_createdAt_idx").on(
      table.userId,
      table.createdAt,
    ),

    // Calculate success rate by outcome
    index("TradeAttempt_outcome_createdAt_idx").on(
      table.outcome,
      table.createdAt,
    ),

    // Time range queries
    index("TradeAttempt_createdAt_idx").on(table.createdAt),

    // Success rate by trade type
    index("TradeAttempt_tradeType_outcome_createdAt_idx").on(
      table.tradeType,
      table.outcome,
      table.createdAt,
    ),
  ],
);

// Relations
export const tradeAttemptsRelations = relations(tradeAttempts, ({ one }) => ({
  user: one(users, {
    fields: [tradeAttempts.userId],
    references: [users.id],
  }),
}));

// Type exports
export type TradeAttempt = typeof tradeAttempts.$inferSelect;
export type NewTradeAttempt = typeof tradeAttempts.$inferInsert;

// Failure codes for categorization
export const TRADE_FAILURE_CODES = {
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  MARKET_CLOSED: "MARKET_CLOSED",
  MARKET_RESOLVED: "MARKET_RESOLVED",
  PRICE_SLIPPAGE: "PRICE_SLIPPAGE",
  POSITION_LIMIT: "POSITION_LIMIT",
  RATE_LIMITED: "RATE_LIMITED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
  UNKNOWN: "UNKNOWN",
} as const;

export type TradeFailureCode =
  (typeof TRADE_FAILURE_CODES)[keyof typeof TRADE_FAILURE_CODES];
