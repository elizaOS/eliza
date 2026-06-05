/**
 * Achievement & Challenge Service
 *
 * Core engine for tracking achievements and challenges.
 *
 * - Achievements: permanent milestones, query-based progress from existing tables
 * - Challenges: time-bound rotating objectives, deterministic selection from pools
 *
 * All checkProgress calls are fire-and-forget from route handlers.
 */

import { createHash } from "node:crypto";
import {
  agentMessages,
  and,
  chats,
  comments,
  count,
  db,
  eq,
  follows,
  generateSnowflakeId,
  groupMembers,
  groups,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  messages,
  perpPositions,
  positions,
  posts,
  reactions,
  referrals,
  shares,
  sql,
  userAchievements,
  userActivityLogs,
  userChallengeProgress,
  users,
} from "@feed/db";
import {
  ACHIEVEMENT_DEFINITIONS,
  type AchievementDef,
  type AchievementEvent,
  type AchievementEventType,
  ALL_CHALLENGE_DEFINITIONS,
  buildAchievementUnlockedNotification,
  buildChallengeCompletedNotification,
  type ChallengeDef,
  DAILY_CHALLENGE_DEFINITIONS,
  EVENT_TO_TRACKING_TYPES,
  logger,
  POINTS,
  WEEKLY_CHALLENGE_DEFINITIONS,
} from "@feed/shared";
import { broadcastToChannel } from "../sse/event-broadcaster";
import { createNotification } from "./notification-service";
import { ReputationService } from "./reputation-service";

// ── Time Helpers ───────────────────────────────────────────────────

function getUTCDateString(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10); // '2026-03-06'
}

function getISOWeekString(date: Date = new Date()): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function getStartOfUTCDay(date: Date = new Date()): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function getEndOfUTCDay(date: Date = new Date()): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1),
  );
}

function getStartOfISOWeek(date: Date = new Date()): Date {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = d.getUTCDay() || 7; // Monday=1, Sunday=7
  d.setUTCDate(d.getUTCDate() - day + 1); // Back to Monday
  return d;
}

function getEndOfISOWeek(date: Date = new Date()): Date {
  const start = getStartOfISOWeek(date);
  return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
}

function countValue(rows: ReadonlyArray<{ c?: number | null }>): number {
  return rows[0]?.c ?? 0;
}

// ── Deterministic Challenge Rotation ───────────────────────────────

function selectChallengeIds(
  pool: ChallengeDef[],
  pickCount: number,
  seed: string,
): string[] {
  const hash = createHash("sha256").update(seed).digest();
  const selected: number[] = [];
  let offset = 0;

  while (selected.length < pickCount && offset <= hash.length - 4) {
    const idx = hash.readUInt32BE(offset) % pool.length;
    if (!selected.includes(idx)) {
      selected.push(idx);
    }
    offset += 4;
  }

  return selected
    .map((i) => pool[i]?.id)
    .filter((id): id is string => typeof id === "string");
}

export function getActiveDailyChallengeIds(date: Date = new Date()): string[] {
  return selectChallengeIds(
    DAILY_CHALLENGE_DEFINITIONS,
    3,
    `daily:${getUTCDateString(date)}`,
  );
}

export function getActiveWeeklyChallengeIds(date: Date = new Date()): string[] {
  return selectChallengeIds(
    WEEKLY_CHALLENGE_DEFINITIONS,
    2,
    `weekly:${getISOWeekString(date)}`,
  );
}

// ── Progress Resolvers (Achievements) ──────────────────────────────
// Each resolver counts lifetime progress for a tracking type.

type ProgressResolver = (userId: string) => Promise<number>;

const ACHIEVEMENT_RESOLVERS: Record<string, ProgressResolver> = {
  prediction_trade_count: async (userId) => {
    const result = await db
      .select({ c: count() })
      .from(positions)
      .where(eq(positions.userId, userId));
    return countValue(result);
  },

  perp_trade_count: async (userId) => {
    const result = await db
      .select({ c: count() })
      .from(perpPositions)
      .where(eq(perpPositions.userId, userId));
    return countValue(result);
  },

  total_trade_count: async (userId) => {
    const predResult = await db
      .select({ c: count() })
      .from(positions)
      .where(eq(positions.userId, userId));
    const perpResult = await db
      .select({ c: count() })
      .from(perpPositions)
      .where(eq(perpPositions.userId, userId));
    return countValue(predResult) + countValue(perpResult);
  },

  distinct_markets: async (userId) => {
    const result = await db
      .select({ c: sql<number>`COUNT(DISTINCT ${positions.marketId})` })
      .from(positions)
      .where(eq(positions.userId, userId));
    return countValue(result);
  },

  prediction_win_count: async (userId) => {
    const result = await db
      .select({ c: count() })
      .from(positions)
      .where(and(eq(positions.userId, userId), eq(positions.outcome, true)));
    return countValue(result);
  },

  agent_count: async (userId) => {
    const result = await db
      .select({ c: count() })
      .from(users)
      .where(and(eq(users.managedBy, userId), eq(users.isAgent, true)));
    return countValue(result);
  },

  agent_message_count: async (userId) => {
    // Count messages sent to agents managed by this user
    const result = await db
      .select({ c: count() })
      .from(agentMessages)
      .innerJoin(users, eq(agentMessages.agentUserId, users.id))
      .where(eq(users.managedBy, userId));
    return countValue(result);
  },

  agent_trade_count: async (userId) => {
    // Count trades by agents managed by this user
    // AgentTrade table has agentUserId; join to User where managedBy = userId
    const result = await db
      .select({ c: count() })
      .from(sql`"AgentTrade" at2`)
      .innerJoin(users, sql`at2."agentUserId" = ${users.id}`)
      .where(eq(users.managedBy, userId));
    return countValue(result);
  },

  group_message_count: async (userId) => {
    const result = await db
      .select({ c: count() })
      .from(messages)
      .innerJoin(chats, eq(messages.chatId, chats.id))
      .where(and(eq(messages.senderId, userId), eq(chats.isGroup, true)));
    return countValue(result);
  },

  comment_count: async (userId) => {
    const result = await db
      .select({ c: count() })
      .from(comments)
      .where(and(eq(comments.authorId, userId), isNull(comments.deletedAt)));
    return countValue(result);
  },

  terminal_visit_count: async (userId) => {
    const result = await db
      .select({ c: count() })
      .from(userActivityLogs)
      .where(
        and(
          eq(userActivityLogs.userId, userId),
          eq(userActivityLogs.activityType, "open_terminal"),
        ),
      );
    return countValue(result);
  },

  agents_visit_count: async (userId) => {
    const result = await db
      .select({ c: count() })
      .from(userActivityLogs)
      .where(
        and(
          eq(userActivityLogs.userId, userId),
          eq(userActivityLogs.activityType, "open_agents"),
        ),
      );
    return countValue(result);
  },

  login_streak: async (userId) => {
    const result = await db
      .select({ streak: users.dailyLoginStreak })
      .from(users)
      .where(eq(users.id, userId));
    return result[0]?.streak ?? 0;
  },
};

// ── Progress Resolvers (Challenges — windowed) ─────────────────────
// Each resolver counts progress within a time window.

type WindowedResolver = (
  userId: string,
  start: Date,
  end: Date,
) => Promise<number>;

const CHALLENGE_RESOLVERS: Record<string, WindowedResolver> = {
  // ── Simple counts ──

  daily_pred_trade: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          gte(positions.createdAt, start),
          lt(positions.createdAt, end),
        ),
      );
    return countValue(r);
  },

  daily_perp_trade: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.userId, userId),
          gte(perpPositions.openedAt, start),
          lt(perpPositions.openedAt, end),
        ),
      );
    return countValue(r);
  },

  daily_total_trade: async (userId, start, end) => {
    const pred = await db
      .select({ c: count() })
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          gte(positions.createdAt, start),
          lt(positions.createdAt, end),
        ),
      );
    const perp = await db
      .select({ c: count() })
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.userId, userId),
          gte(perpPositions.openedAt, start),
          lt(perpPositions.openedAt, end),
        ),
      );
    return countValue(pred) + countValue(perp);
  },

  daily_distinct_markets: async (userId, start, end) => {
    const r = await db
      .select({ c: sql<number>`COUNT(DISTINCT ${positions.marketId})` })
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          gte(positions.createdAt, start),
          lt(positions.createdAt, end),
        ),
      );
    return countValue(r);
  },

  daily_post: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(posts)
      .where(
        and(
          eq(posts.authorId, userId),
          gte(posts.timestamp, start),
          lt(posts.timestamp, end),
        ),
      );
    return countValue(r);
  },

  daily_comment: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(comments)
      .where(
        and(
          eq(comments.authorId, userId),
          isNull(comments.deletedAt),
          gte(comments.createdAt, start),
          lt(comments.createdAt, end),
        ),
      );
    return countValue(r);
  },

  daily_reaction: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(reactions)
      .where(
        and(
          eq(reactions.userId, userId),
          gte(reactions.createdAt, start),
          lt(reactions.createdAt, end),
        ),
      );
    return countValue(r);
  },

  daily_group_message: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(messages)
      .innerJoin(chats, eq(messages.chatId, chats.id))
      .where(
        and(
          eq(messages.senderId, userId),
          eq(chats.isGroup, true),
          gte(messages.createdAt, start),
          lt(messages.createdAt, end),
        ),
      );
    return countValue(r);
  },

  daily_agent_message: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(agentMessages)
      .innerJoin(users, eq(agentMessages.agentUserId, users.id))
      .where(
        and(
          eq(users.managedBy, userId),
          gte(agentMessages.createdAt, start),
          lt(agentMessages.createdAt, end),
        ),
      );
    return countValue(r);
  },

  daily_follow: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(follows)
      .where(
        and(
          eq(follows.followerId, userId),
          gte(follows.createdAt, start),
          lt(follows.createdAt, end),
        ),
      );
    return countValue(r);
  },

  daily_share: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(shares)
      .where(
        and(
          eq(shares.userId, userId),
          gte(shares.createdAt, start),
          lt(shares.createdAt, end),
        ),
      );
    return countValue(r);
  },

  // ── Page visits (UserActivityLog) ──

  daily_terminal_visit: async (userId, start, _end) => {
    const dateOnly = getStartOfUTCDay(start);
    const r = await db
      .select({ c: count() })
      .from(userActivityLogs)
      .where(
        and(
          eq(userActivityLogs.userId, userId),
          eq(userActivityLogs.activityType, "open_terminal"),
          eq(userActivityLogs.activityDate, dateOnly),
        ),
      );
    return countValue(r);
  },

  daily_agents_visit: async (userId, start, _end) => {
    const dateOnly = getStartOfUTCDay(start);
    const r = await db
      .select({ c: count() })
      .from(userActivityLogs)
      .where(
        and(
          eq(userActivityLogs.userId, userId),
          eq(userActivityLogs.activityType, "open_agents"),
          eq(userActivityLogs.activityDate, dateOnly),
        ),
      );
    return countValue(r);
  },

  daily_markets_visit: async (userId, start, _end) => {
    const dateOnly = getStartOfUTCDay(start);
    const r = await db
      .select({ c: count() })
      .from(userActivityLogs)
      .where(
        and(
          eq(userActivityLogs.userId, userId),
          eq(userActivityLogs.activityType, "open_terminal"),
          eq(userActivityLogs.activityDate, dateOnly),
        ),
      );
    return countValue(r);
  },

  daily_feed_visit: async (userId, start, _end) => {
    const dateOnly = getStartOfUTCDay(start);
    const r = await db
      .select({ c: count() })
      .from(userActivityLogs)
      .where(
        and(
          eq(userActivityLogs.userId, userId),
          eq(userActivityLogs.activityType, "open_feed"),
          eq(userActivityLogs.activityDate, dateOnly),
        ),
      );
    return countValue(r);
  },

  daily_leaderboard_visit: async (userId, start, _end) => {
    const dateOnly = getStartOfUTCDay(start);
    const r = await db
      .select({ c: count() })
      .from(userActivityLogs)
      .where(
        and(
          eq(userActivityLogs.userId, userId),
          eq(userActivityLogs.activityType, "open_leaderboard"),
          eq(userActivityLogs.activityDate, dateOnly),
        ),
      );
    return countValue(r);
  },

  daily_notifications_visit: async (userId, start, _end) => {
    const dateOnly = getStartOfUTCDay(start);
    const r = await db
      .select({ c: count() })
      .from(userActivityLogs)
      .where(
        and(
          eq(userActivityLogs.userId, userId),
          eq(userActivityLogs.activityType, "open_notifications"),
          eq(userActivityLogs.activityDate, dateOnly),
        ),
      );
    return countValue(r);
  },

  daily_market_detail_visit: async (userId, start, _end) => {
    const dateOnly = getStartOfUTCDay(start);
    const r = await db
      .select({ c: count() })
      .from(userActivityLogs)
      .where(
        and(
          eq(userActivityLogs.userId, userId),
          eq(userActivityLogs.activityType, "open_market_detail"),
          eq(userActivityLogs.activityDate, dateOnly),
        ),
      );
    return countValue(r);
  },

  daily_group_join: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.userId, userId),
          gte(groupMembers.joinedAt, start),
          lt(groupMembers.joinedAt, end),
        ),
      );
    return countValue(r);
  },

  // ── Compound daily ──

  daily_pred_and_perp: async (userId, start, end) => {
    const pred = await db
      .select({ c: count() })
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          gte(positions.createdAt, start),
          lt(positions.createdAt, end),
        ),
      );
    const perp = await db
      .select({ c: count() })
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.userId, userId),
          gte(perpPositions.openedAt, start),
          lt(perpPositions.openedAt, end),
        ),
      );
    return countValue(pred) > 0 && countValue(perp) > 0 ? 1 : 0;
  },

  // ── Weekly resolvers ──

  weekly_pred_trade: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          gte(positions.createdAt, start),
          lt(positions.createdAt, end),
        ),
      );
    return countValue(r);
  },

  weekly_perp_trade: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.userId, userId),
          gte(perpPositions.openedAt, start),
          lt(perpPositions.openedAt, end),
        ),
      );
    return countValue(r);
  },

  weekly_total_trade: async (userId, start, end) => {
    const pred = await db
      .select({ c: count() })
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          gte(positions.createdAt, start),
          lt(positions.createdAt, end),
        ),
      );
    const perp = await db
      .select({ c: count() })
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.userId, userId),
          gte(perpPositions.openedAt, start),
          lt(perpPositions.openedAt, end),
        ),
      );
    return countValue(pred) + countValue(perp);
  },

  weekly_distinct_markets: async (userId, start, end) => {
    const r = await db
      .select({ c: sql<number>`COUNT(DISTINCT ${positions.marketId})` })
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          gte(positions.createdAt, start),
          lt(positions.createdAt, end),
        ),
      );
    return countValue(r);
  },

  weekly_trade_win: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          eq(positions.outcome, true),
          gte(positions.resolvedAt, start),
          lt(positions.resolvedAt, end),
        ),
      );
    return countValue(r);
  },

  weekly_post: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(posts)
      .where(
        and(
          eq(posts.authorId, userId),
          gte(posts.timestamp, start),
          lt(posts.timestamp, end),
        ),
      );
    return countValue(r);
  },

  weekly_comment: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(comments)
      .where(
        and(
          eq(comments.authorId, userId),
          isNull(comments.deletedAt),
          gte(comments.createdAt, start),
          lt(comments.createdAt, end),
        ),
      );
    return countValue(r);
  },

  weekly_reaction: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(reactions)
      .where(
        and(
          eq(reactions.userId, userId),
          gte(reactions.createdAt, start),
          lt(reactions.createdAt, end),
        ),
      );
    return countValue(r);
  },

  weekly_group_message: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(messages)
      .innerJoin(chats, eq(messages.chatId, chats.id))
      .where(
        and(
          eq(messages.senderId, userId),
          eq(chats.isGroup, true),
          gte(messages.createdAt, start),
          lt(messages.createdAt, end),
        ),
      );
    return countValue(r);
  },

  weekly_agent_message: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(agentMessages)
      .innerJoin(users, eq(agentMessages.agentUserId, users.id))
      .where(
        and(
          eq(users.managedBy, userId),
          gte(agentMessages.createdAt, start),
          lt(agentMessages.createdAt, end),
        ),
      );
    return countValue(r);
  },

  weekly_agent_trade: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(sql`"AgentTrade" at2`)
      .innerJoin(users, sql`at2."agentUserId" = ${users.id}`)
      .where(
        and(
          eq(users.managedBy, userId),
          sql`at2."executedAt" >= ${start}`,
          sql`at2."executedAt" < ${end}`,
        ),
      );
    return countValue(r);
  },

  weekly_follow: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(follows)
      .where(
        and(
          eq(follows.followerId, userId),
          gte(follows.createdAt, start),
          lt(follows.createdAt, end),
        ),
      );
    return countValue(r);
  },

  weekly_share: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(shares)
      .where(
        and(
          eq(shares.userId, userId),
          gte(shares.createdAt, start),
          lt(shares.createdAt, end),
        ),
      );
    return countValue(r);
  },

  weekly_group_join: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.userId, userId),
          gte(groupMembers.joinedAt, start),
          lt(groupMembers.joinedAt, end),
        ),
      );
    return countValue(r);
  },

  weekly_group_create: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(groups)
      .where(
        and(
          eq(groups.createdById, userId),
          gte(groups.createdAt, start),
          lt(groups.createdAt, end),
        ),
      );
    return countValue(r);
  },

  weekly_login_days: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(userActivityLogs)
      .where(
        and(
          eq(userActivityLogs.userId, userId),
          eq(userActivityLogs.activityType, "session"),
          gte(userActivityLogs.activityDate, start),
          lt(userActivityLogs.activityDate, end),
        ),
      );
    return countValue(r);
  },

  weekly_trade_days: async (userId, start, end) => {
    const r = await db
      .select({ c: sql<number>`COUNT(DISTINCT DATE(${positions.createdAt}))` })
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          gte(positions.createdAt, start),
          lt(positions.createdAt, end),
        ),
      );
    return countValue(r);
  },

  // ── Compound weekly ──

  weekly_pred_and_perp: async (userId, start, end) => {
    const pred = await db
      .select({ c: count() })
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          gte(positions.createdAt, start),
          lt(positions.createdAt, end),
        ),
      );
    const perp = await db
      .select({ c: count() })
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.userId, userId),
          gte(perpPositions.openedAt, start),
          lt(perpPositions.openedAt, end),
        ),
      );
    return countValue(pred) > 0 && countValue(perp) > 0 ? 1 : 0;
  },

  weekly_agent_and_group: async (userId, start, end) => {
    const hasAgent = await db
      .select({ c: count() })
      .from(agentMessages)
      .innerJoin(users, eq(agentMessages.agentUserId, users.id))
      .where(
        and(
          eq(users.managedBy, userId),
          gte(agentMessages.createdAt, start),
          lt(agentMessages.createdAt, end),
        ),
      );
    const hasGroup = await db
      .select({ c: count() })
      .from(messages)
      .innerJoin(chats, eq(messages.chatId, chats.id))
      .where(
        and(
          eq(messages.senderId, userId),
          eq(chats.isGroup, true),
          gte(messages.createdAt, start),
          lt(messages.createdAt, end),
        ),
      );
    return countValue(hasAgent) > 0 && countValue(hasGroup) > 0 ? 1 : 0;
  },

  weekly_agent_interact: async (userId, start, end) => {
    // Distinct agents created or messaged this week
    const created = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.managedBy, userId),
          eq(users.isAgent, true),
          gte(users.createdAt, start),
          lt(users.createdAt, end),
        ),
      );
    const messaged = await db
      .select({ agentId: agentMessages.agentUserId })
      .from(agentMessages)
      .innerJoin(users, eq(agentMessages.agentUserId, users.id))
      .where(
        and(
          eq(users.managedBy, userId),
          gte(agentMessages.createdAt, start),
          lt(agentMessages.createdAt, end),
        ),
      )
      .groupBy(agentMessages.agentUserId);
    const uniqueAgents = new Set([
      ...created.map((r) => r.id),
      ...messaged.map((r) => r.agentId),
    ]);
    return uniqueAgents.size;
  },

  weekly_positive_pnl: async (userId, start, end) => {
    const predPnl = await db
      .select({ total: sql<string>`COALESCE(SUM(${positions.pnl}), '0')` })
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          isNotNull(positions.resolvedAt),
          gte(positions.resolvedAt, start),
          lt(positions.resolvedAt, end),
        ),
      );
    const perpPnl = await db
      .select({
        total: sql<string>`COALESCE(SUM(${perpPositions.realizedPnL}), '0')`,
      })
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.userId, userId),
          isNotNull(perpPositions.closedAt),
          gte(perpPositions.closedAt, start),
          lt(perpPositions.closedAt, end),
        ),
      );
    const totalPnl = Number(predPnl[0]?.total) + Number(perpPnl[0]?.total);
    return totalPnl > 0 ? 1 : 0;
  },

  weekly_feed_engage: async (userId, start, end) => {
    const likedPosts = await db
      .select({ c: sql<number>`COUNT(DISTINCT ${reactions.postId})` })
      .from(reactions)
      .where(
        and(
          eq(reactions.userId, userId),
          isNotNull(reactions.postId),
          gte(reactions.createdAt, start),
          lt(reactions.createdAt, end),
        ),
      );
    const commentedPosts = await db
      .select({ c: sql<number>`COUNT(DISTINCT ${comments.postId})` })
      .from(comments)
      .where(
        and(
          eq(comments.authorId, userId),
          isNull(comments.deletedAt),
          gte(comments.createdAt, start),
          lt(comments.createdAt, end),
        ),
      );
    // Threshold is applied to the minimum of both (must have >= threshold of each)
    return Math.min(countValue(likedPosts), countValue(commentedPosts));
  },

  weekly_referral_play: async (userId, start, end) => {
    const r = await db
      .select({ c: count() })
      .from(referrals)
      .innerJoin(positions, eq(referrals.referredUserId, positions.userId))
      .where(
        and(
          eq(referrals.referrerId, userId),
          gte(positions.createdAt, start),
          lt(positions.createdAt, end),
        ),
      );
    return countValue(r) > 0 ? 1 : 0;
  },

  weekly_top_market: async (userId, start, end) => {
    // Find the market with most positions this week
    const topMarket = await db
      .select({ marketId: positions.marketId, vol: count() })
      .from(positions)
      .where(and(gte(positions.createdAt, start), lt(positions.createdAt, end)))
      .groupBy(positions.marketId)
      .orderBy(sql`count(*) DESC`)
      .limit(1);
    if (!topMarket[0]) return 0;
    // Check if user traded in it
    const userTrade = await db
      .select({ c: count() })
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          eq(positions.marketId, topMarket[0].marketId),
          gte(positions.createdAt, start),
          lt(positions.createdAt, end),
        ),
      );
    return countValue(userTrade) > 0 ? 1 : 0;
  },
};

// ── Achievement Engine ─────────────────────────────────────────────

/**
 * Check and potentially unlock achievements + advance challenges for a user.
 * This is the main entry point called from route handlers (fire-and-forget).
 */
export async function checkProgress(
  userId: string,
  event: AchievementEvent,
): Promise<void> {
  const eventType = event.type as AchievementEventType;
  const relevantTrackingTypes = EVENT_TO_TRACKING_TYPES[eventType];
  if (!relevantTrackingTypes || relevantTrackingTypes.length === 0) return;

  try {
    await Promise.all([
      checkAchievements(userId, relevantTrackingTypes),
      checkChallenges(userId, event, relevantTrackingTypes),
    ]);
  } catch (error) {
    // Log but don't rethrow — checkProgress is fire-and-forget
    logger.error(
      "checkProgress failed",
      {
        userId,
        eventType,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      "AchievementService",
    );
  }
}

async function checkAchievements(
  userId: string,
  relevantTrackingTypes: string[],
): Promise<void> {
  // Find achievement definitions whose trackingType matches
  const relevantAchievements = ACHIEVEMENT_DEFINITIONS.filter((a) =>
    relevantTrackingTypes.includes(a.trackingType),
  );
  if (relevantAchievements.length === 0) return;

  // Check which of these the user has already unlocked
  const alreadyUnlocked = await db
    .select({ achievementId: userAchievements.achievementId })
    .from(userAchievements)
    .where(
      and(
        eq(userAchievements.userId, userId),
        inArray(
          userAchievements.achievementId,
          relevantAchievements.map((a) => a.id),
        ),
      ),
    );
  const unlockedSet = new Set(alreadyUnlocked.map((r) => r.achievementId));

  // Check each non-unlocked achievement
  for (const achievement of relevantAchievements) {
    if (unlockedSet.has(achievement.id)) continue;

    const resolver = ACHIEVEMENT_RESOLVERS[achievement.trackingType];
    if (!resolver) {
      logger.warn(
        `No achievement resolver for trackingType: ${achievement.trackingType}`,
        undefined,
        "AchievementService",
      );
      continue;
    }

    const progress = await resolver(userId);
    if (progress >= achievement.threshold) {
      await unlockAchievement(userId, achievement);
    }
  }
}

async function unlockAchievement(
  userId: string,
  achievement: AchievementDef,
): Promise<void> {
  // Insert with conflict guard (unique on userId + achievementId)
  const [inserted] = await db
    .insert(userAchievements)
    .values({
      id: await generateSnowflakeId(),
      userId,
      achievementId: achievement.id,
      pointsAwarded: achievement.pointsReward,
      unlockedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();

  if (!inserted) return; // Already unlocked by a concurrent request

  // Award points
  await ReputationService.awardReputation(
    userId,
    achievement.pointsReward,
    "achievement_unlock",
    {
      achievementId: achievement.id,
      achievementName: achievement.name,
      tier: achievement.tier,
    },
  );

  const notification = buildAchievementUnlockedNotification({
    achievementId: achievement.id,
    achievementName: achievement.name,
    tier: achievement.tier,
    pointsReward: achievement.pointsReward,
    iconKey: achievement.iconKey,
  });

  // Create notification + SSE broadcast (both required)
  await createNotification({
    userId,
    type: "achievement_unlocked",
    title: notification.title,
    message: notification.message,
    data: notification.data,
  });

  await broadcastToChannel(`notifications:${userId}`, {
    type: "achievement_unlocked",
    achievementId: achievement.id,
    name: achievement.name,
    tier: achievement.tier,
    pointsReward: achievement.pointsReward,
    iconKey: achievement.iconKey,
  });

  logger.info(
    `Achievement unlocked: ${achievement.id} for user ${userId}`,
    {
      achievementId: achievement.id,
      tier: achievement.tier,
      points: achievement.pointsReward,
    },
    "AchievementService",
  );
}

// ── Challenge Engine ───────────────────────────────────────────────

async function checkChallenges(
  userId: string,
  _event: AchievementEvent,
  relevantTrackingTypes: string[],
): Promise<void> {
  const now = new Date();
  const dailyIds = getActiveDailyChallengeIds(now);
  const weeklyIds = getActiveWeeklyChallengeIds(now);

  // Find active challenge definitions whose trackingType matches
  const allActiveIds = [...dailyIds, ...weeklyIds];
  const relevantChallenges = ALL_CHALLENGE_DEFINITIONS.filter(
    (c) =>
      allActiveIds.includes(c.id) &&
      relevantTrackingTypes.includes(c.trackingType),
  );
  if (relevantChallenges.length === 0) return;

  for (const challenge of relevantChallenges) {
    try {
      const isDaily = challenge.pool === "daily";
      const periodKey = isDaily ? getUTCDateString(now) : getISOWeekString(now);
      const start = isDaily ? getStartOfUTCDay(now) : getStartOfISOWeek(now);
      const end = isDaily ? getEndOfUTCDay(now) : getEndOfISOWeek(now);

      // Check if already completed for this period
      const existing = await db
        .select({
          id: userChallengeProgress.id,
          completed: userChallengeProgress.completed,
        })
        .from(userChallengeProgress)
        .where(
          and(
            eq(userChallengeProgress.userId, userId),
            eq(userChallengeProgress.challengeId, challenge.id),
            eq(userChallengeProgress.periodKey, periodKey),
          ),
        );

      if (existing[0]?.completed === 1) continue; // Already done

      // Resolve current progress
      const resolver = CHALLENGE_RESOLVERS[challenge.trackingType];
      if (!resolver) {
        logger.warn(
          `No challenge resolver for trackingType: ${challenge.trackingType}`,
          undefined,
          "AchievementService",
        );
        continue;
      }

      const progress = await resolver(userId, start, end);
      const completed = progress >= challenge.threshold ? 1 : 0;
      const completedAt = completed ? new Date() : null;

      // Track whether this request actually transitioned to completed
      let didComplete = false;

      if (existing[0]) {
        // Update existing progress — only award if we transition completed 0→1
        if (completed && !existing[0].completed) {
          const [updated] = await db
            .update(userChallengeProgress)
            .set({
              progress,
              completed,
              completedAt,
              pointsAwarded: challenge.pointsReward,
            })
            .where(
              and(
                eq(userChallengeProgress.id, existing[0].id),
                eq(userChallengeProgress.completed, 0),
              ),
            )
            .returning({ id: userChallengeProgress.id });
          didComplete = !!updated;
        } else {
          // Just update progress, not completing
          await db
            .update(userChallengeProgress)
            .set({ progress, completed, completedAt })
            .where(eq(userChallengeProgress.id, existing[0].id));
        }
      } else {
        // Insert new progress record — returning confirms insert won the race
        const [inserted] = await db
          .insert(userChallengeProgress)
          .values({
            id: await generateSnowflakeId(),
            userId,
            challengeId: challenge.id,
            periodKey,
            progress,
            completed,
            completedAt,
            pointsAwarded: completed ? challenge.pointsReward : 0,
          })
          .onConflictDoNothing()
          .returning({ id: userChallengeProgress.id });
        didComplete = completed === 1 && !!inserted;
      }

      // Award points only if this request actually transitioned to completed
      if (didComplete) {
        await ReputationService.awardReputation(
          userId,
          challenge.pointsReward,
          "challenge_complete",
          {
            challengeId: challenge.id,
            challengeName: challenge.name,
            periodKey,
          },
        );

        const notification = buildChallengeCompletedNotification({
          challengeId: challenge.id,
          challengeName: challenge.name,
          pointsReward: challenge.pointsReward,
          periodKey,
          iconKey: challenge.iconKey,
        });

        await createNotification({
          userId,
          type: "challenge_completed",
          title: notification.title,
          message: notification.message,
          data: notification.data,
        });

        await broadcastToChannel(`notifications:${userId}`, {
          type: "challenge_completed",
          challengeId: challenge.id,
          name: challenge.name,
          pointsReward: challenge.pointsReward,
          iconKey: challenge.iconKey,
        });

        // Check for all-complete bonus
        await checkCompletionBonus(
          userId,
          challenge.pool,
          periodKey,
          isDaily ? dailyIds : weeklyIds,
        );
      }
    } catch (error) {
      logger.error(
        `Challenge check failed for ${challenge.id}`,
        {
          userId,
          challengeId: challenge.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "AchievementService",
      );
    }
  }
}

async function checkCompletionBonus(
  userId: string,
  pool: "daily" | "weekly",
  periodKey: string,
  activeIds: string[],
): Promise<void> {
  const completedCount = await db
    .select({ c: count() })
    .from(userChallengeProgress)
    .where(
      and(
        eq(userChallengeProgress.userId, userId),
        eq(userChallengeProgress.periodKey, periodKey),
        inArray(userChallengeProgress.challengeId, activeIds),
        eq(userChallengeProgress.completed, 1),
      ),
    );

  const target = pool === "daily" ? 3 : 2;
  if (countValue(completedCount) !== target) return;

  // Check if bonus already awarded (use a special periodKey suffix)
  const bonusPeriodKey = `${periodKey}:bonus`;
  const existing = await db
    .select({ c: count() })
    .from(userChallengeProgress)
    .where(
      and(
        eq(userChallengeProgress.userId, userId),
        eq(userChallengeProgress.periodKey, bonusPeriodKey),
      ),
    );
  if (countValue(existing) > 0) return; // Already awarded

  const bonus =
    pool === "daily"
      ? POINTS.CHALLENGE_DAILY_ALL_BONUS
      : POINTS.CHALLENGE_WEEKLY_ALL_BONUS;

  // Record the bonus award
  const [insertedBonus] = await db
    .insert(userChallengeProgress)
    .values({
      id: await generateSnowflakeId(),
      userId,
      challengeId: `${pool}_all_bonus`,
      periodKey: bonusPeriodKey,
      progress: target,
      completed: 1,
      completedAt: new Date(),
      pointsAwarded: bonus,
    })
    .onConflictDoNothing()
    .returning({ id: userChallengeProgress.id });

  if (!insertedBonus) return;

  await ReputationService.awardReputation(userId, bonus, "challenge_complete", {
    type: `${pool}_all_bonus`,
    periodKey,
  });

  await broadcastToChannel(`notifications:${userId}`, {
    type: "challenge_bonus",
    pool,
    bonus,
  });

  logger.info(
    `${pool} completion bonus awarded to user ${userId}: +${bonus}`,
    { pool, periodKey, bonus },
    "AchievementService",
  );
}

// ── Query Methods (for API endpoints) ──────────────────────────────

export interface AchievementWithProgress {
  id: string;
  name: string;
  description: string;
  category: string;
  tier: string;
  iconKey: string;
  pointsReward: number;
  threshold: number;
  progress: number;
  unlocked: boolean;
  unlockedAt: Date | null;
}

export async function getUserAchievements(
  userId: string,
): Promise<AchievementWithProgress[]> {
  // Get user's unlocked achievements
  const unlocked = await db
    .select({
      achievementId: userAchievements.achievementId,
      unlockedAt: userAchievements.unlockedAt,
    })
    .from(userAchievements)
    .where(eq(userAchievements.userId, userId));

  const unlockedMap = new Map(
    unlocked.map((u) => [u.achievementId, u.unlockedAt]),
  );

  // Build result with progress for each achievement
  const results: AchievementWithProgress[] = [];
  for (const def of ACHIEVEMENT_DEFINITIONS) {
    const isUnlocked = unlockedMap.has(def.id);
    let progress = 0;

    if (isUnlocked) {
      progress = def.threshold; // Already done
    } else {
      const resolver = ACHIEVEMENT_RESOLVERS[def.trackingType];
      if (resolver) {
        progress = await resolver(userId);
      }
    }

    results.push({
      id: def.id,
      name: def.name,
      description: def.description,
      category: def.category,
      tier: def.tier,
      iconKey: def.iconKey,
      pointsReward: def.pointsReward,
      threshold: def.threshold,
      progress: Math.min(progress, def.threshold),
      unlocked: isUnlocked,
      unlockedAt: unlockedMap.get(def.id) ?? null,
    });
  }

  return results;
}

export interface ChallengeWithProgress {
  id: string;
  name: string;
  description: string;
  hint: string;
  category: string;
  iconKey: string;
  pointsReward: number;
  threshold: number;
  progress: number;
  completed: boolean;
  completedAt: Date | null;
}

export interface ChallengesResponse {
  daily: {
    challenges: ChallengeWithProgress[];
    allCompletedBonus: number;
    allCompleted: boolean;
    resetsAt: string;
  };
  weekly: {
    challenges: ChallengeWithProgress[];
    allCompletedBonus: number;
    allCompleted: boolean;
    resetsAt: string;
  };
}

export async function getUserChallenges(
  userId: string,
): Promise<ChallengesResponse> {
  const now = new Date();
  const dailyPeriodKey = getUTCDateString(now);
  const weeklyPeriodKey = getISOWeekString(now);

  const dailyIds = getActiveDailyChallengeIds(now);
  const weeklyIds = getActiveWeeklyChallengeIds(now);

  // Fetch all progress for this user in current periods
  const progressRows = await db
    .select()
    .from(userChallengeProgress)
    .where(
      and(
        eq(userChallengeProgress.userId, userId),
        inArray(userChallengeProgress.periodKey, [
          dailyPeriodKey,
          weeklyPeriodKey,
        ]),
      ),
    );

  const progressMap = new Map(progressRows.map((r) => [r.challengeId, r]));

  const buildChallenges = async (
    ids: string[],
    pool: ChallengeDef[],
    _periodKey: string,
  ): Promise<ChallengeWithProgress[]> => {
    const results: ChallengeWithProgress[] = [];

    for (const id of ids) {
      const def = pool.find((c) => c.id === id);
      if (!def) continue;

      const existing = progressMap.get(id);
      let progress = existing?.progress ?? 0;
      const completed = existing?.completed === 1;

      // If not completed and we have a resolver, get fresh progress
      if (!completed) {
        const isDaily = def.pool === "daily";
        const start = isDaily ? getStartOfUTCDay(now) : getStartOfISOWeek(now);
        const end = isDaily ? getEndOfUTCDay(now) : getEndOfISOWeek(now);
        const resolver = CHALLENGE_RESOLVERS[def.trackingType];
        if (resolver) {
          progress = await resolver(userId, start, end);
        }
      }

      results.push({
        id: def.id,
        name: def.name,
        description: def.description,
        hint: def.hint,
        category: def.category,
        iconKey: def.iconKey,
        pointsReward: def.pointsReward,
        threshold: def.threshold,
        progress: Math.min(progress, def.threshold),
        completed,
        completedAt: existing?.completedAt ?? null,
      });
    }

    return results;
  };

  const dailyChallenges = await buildChallenges(
    dailyIds,
    DAILY_CHALLENGE_DEFINITIONS,
    dailyPeriodKey,
  );
  const weeklyChallenges = await buildChallenges(
    weeklyIds,
    WEEKLY_CHALLENGE_DEFINITIONS,
    weeklyPeriodKey,
  );

  const dailyAllCompleted =
    dailyChallenges.length === 3 && dailyChallenges.every((c) => c.completed);
  const weeklyAllCompleted =
    weeklyChallenges.length === 2 && weeklyChallenges.every((c) => c.completed);

  // Calculate reset times
  const dailyResetsAt = getEndOfUTCDay(now).toISOString();
  const weeklyResetsAt = getEndOfISOWeek(now).toISOString();

  return {
    daily: {
      challenges: dailyChallenges,
      allCompletedBonus: POINTS.CHALLENGE_DAILY_ALL_BONUS,
      allCompleted: dailyAllCompleted,
      resetsAt: dailyResetsAt,
    },
    weekly: {
      challenges: weeklyChallenges,
      allCompletedBonus: POINTS.CHALLENGE_WEEKLY_ALL_BONUS,
      allCompleted: weeklyAllCompleted,
      resetsAt: weeklyResetsAt,
    },
  };
}

export async function getRecentAchievements(
  userId: string,
  limit = 5,
): Promise<AchievementWithProgress[]> {
  const recent = await db
    .select({
      achievementId: userAchievements.achievementId,
      unlockedAt: userAchievements.unlockedAt,
    })
    .from(userAchievements)
    .where(eq(userAchievements.userId, userId))
    .orderBy(sql`${userAchievements.unlockedAt} DESC`)
    .limit(limit);

  return recent.map((r) => {
    const def = ACHIEVEMENT_DEFINITIONS.find((a) => a.id === r.achievementId);
    if (!def) {
      return {
        id: r.achievementId,
        name: "Unknown",
        description: "",
        category: "",
        tier: "bronze",
        iconKey: "award",
        pointsReward: 0,
        threshold: 1,
        progress: 1,
        unlocked: true,
        unlockedAt: r.unlockedAt,
      };
    }
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      category: def.category,
      tier: def.tier,
      iconKey: def.iconKey,
      pointsReward: def.pointsReward,
      threshold: def.threshold,
      progress: def.threshold,
      unlocked: true,
      unlockedAt: r.unlockedAt,
    };
  });
}
