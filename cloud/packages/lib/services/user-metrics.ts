/**
 * User Metrics Service
 *
 * Aggregates engagement data from Eliza rooms + memories which serve as
 * the shared message backbone for all channels (web, telegram, discord,
 * iMessage/blooio, sms, elizaos).
 *
 * Room `source` values map to MetricsPlatform as follows:
 *   'web'       → web
 *   'telegram'  → telegram
 *   'discord'   → discord
 *   'blooio'    → imessage
 *   'elizaos'   → included in aggregate only
 *
 * Provides pre-computed daily metrics via cron and live queries for the
 * admin engagement dashboard.
 */

import {
  and,
  count,
  countDistinct,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { type DailyMetric, dailyMetrics, type MetricsPlatform } from "@/db/schemas/daily-metrics";
import { memoryTable, roomTable } from "@/db/schemas/eliza";
import { platformCredentials } from "@/db/schemas/platform-credentials";
import { type RetentionCohort, retentionCohorts } from "@/db/schemas/retention-cohorts";
import { userIdentities } from "@/db/schemas/user-identities";
import { users } from "@/db/schemas/users";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheStaleTTL, CacheTTL } from "@/lib/cache/keys";
import { logger } from "@/lib/utils/logger";

/**
 * Maps a MetricsPlatform to Eliza room source values.
 * When platform is null (aggregate), all known sources are included.
 */
const PLATFORM_TO_SOURCES: Record<MetricsPlatform, string[]> = {
  web: ["web"],
  telegram: ["telegram"],
  discord: ["discord"],
  imessage: ["blooio"],
  sms: [],
};
const ALL_SOURCES = ["web", "telegram", "discord", "blooio", "elizaos"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveUsersResult {
  total: number;
  byPlatform: Record<string, number>;
}

export interface SignupsResult {
  total: number;
  byDay: Array<{ date: string; count: number }>;
}

export interface MessagesPerUserResult {
  average: number;
  median: number;
}

export interface OAuthConnectionRate {
  total_users: number;
  connected_users: number;
  rate: number;
  byService: Record<string, number>;
}

export interface MetricsOverview {
  dau: number;
  wau: number;
  mau: number;
  newSignupsToday: number;
  newSignups7d: number;
  avgMessagesPerUser: number;
  platformBreakdown: Record<string, number>;
  oauthRate: OAuthConnectionRate;
  dailyTrend: DailyMetric[];
  retentionCohorts: RetentionCohort[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class UserMetricsService {
  // =========================================================================
  // LIVE QUERIES (cached with SWR)
  // =========================================================================

  /**
   * Count unique active users across all platforms in the given window.
   */
  async getActiveUsers(timeRange: "day" | "7d" | "30d"): Promise<ActiveUsersResult> {
    const cacheKey = CacheKeys.userMetrics.activeUsers(timeRange);
    const cached = await cache.getWithSWR<ActiveUsersResult>(
      cacheKey,
      CacheStaleTTL.userMetrics.activeUsers,
      () => this._queryActiveUsers(timeRange),
      CacheTTL.userMetrics.activeUsers,
    );
    return cached ?? this._queryActiveUsers(timeRange);
  }

  private async _queryActiveUsers(timeRange: "day" | "7d" | "30d"): Promise<ActiveUsersResult> {
    const since = this._rangeSince(timeRange);

    // Count distinct message *senders* (memoryTable.entityId) rather than
    // all room participants, so users who didn't send messages aren't counted.
    const rows = await dbRead
      .select({
        source: roomTable.source,
        cnt: countDistinct(memoryTable.entityId),
      })
      .from(memoryTable)
      .innerJoin(roomTable, eq(memoryTable.roomId, roomTable.id))
      .where(
        and(
          inArray(roomTable.source, ALL_SOURCES),
          gte(memoryTable.createdAt, since),
          ne(memoryTable.entityId, roomTable.agentId),
        ),
      )
      .groupBy(roomTable.source);

    const bySrc: Record<string, number> = {};
    for (const row of rows) {
      bySrc[row.source as string] = Number(row.cnt);
    }

    const byPlatform: Record<string, number> = {
      web: bySrc["web"] ?? 0,
      telegram: bySrc["telegram"] ?? 0,
      discord: bySrc["discord"] ?? 0,
      imessage: bySrc["blooio"] ?? 0,
      sms: 0,
    };

    const total = Object.values(byPlatform).reduce((s, n) => s + n, 0);

    return { total, byPlatform };
  }

  /**
   * Count new user signups in a date range.
   */
  async getNewSignups(startDate: Date, endDate: Date): Promise<SignupsResult> {
    const startKey = startDate.toISOString().split("T")[0];
    const endKey = endDate.toISOString().split("T")[0];
    const cacheKey = CacheKeys.userMetrics.signups(startKey, endKey);
    const cached = await cache.get<SignupsResult>(cacheKey);
    if (cached) return cached;

    const rows = await dbRead
      .select({
        day: sql<string>`DATE_TRUNC('day', ${users.created_at})`,
        cnt: count(),
      })
      .from(users)
      .leftJoin(userIdentities, eq(users.id, userIdentities.user_id))
      .where(
        and(
          sql`COALESCE(${userIdentities.is_anonymous}, false) = false`,
          gte(users.created_at, startDate),
          lt(users.created_at, endDate),
        ),
      )
      .groupBy(sql`DATE_TRUNC('day', ${users.created_at})`)
      .orderBy(sql`DATE_TRUNC('day', ${users.created_at})`);

    const byDay = rows.map((r) => ({
      date: new Date(r.day).toISOString().split("T")[0],
      count: Number(r.cnt),
    }));
    const total = byDay.reduce((s, d) => s + d.count, 0);

    const result = { total, byDay };
    await cache.set(cacheKey, result, CacheTTL.userMetrics.signups);
    return result;
  }

  /**
   * OAuth connection rate across all non-anonymous users.
   */
  async getOAuthConnectionRate(): Promise<OAuthConnectionRate> {
    const [totalRow] = await dbRead
      .select({ cnt: count() })
      .from(users)
      .leftJoin(userIdentities, eq(users.id, userIdentities.user_id))
      .where(sql`COALESCE(${userIdentities.is_anonymous}, false) = false`);
    const total_users = Number(totalRow?.cnt ?? 0);

    // Single query: get distinct (user_id, platform) pairs, then derive both
    // per-service counts and total connected users in application code.
    const credRows = await dbRead
      .selectDistinct({
        userId: platformCredentials.user_id,
        platform: platformCredentials.platform,
      })
      .from(platformCredentials)
      .where(
        and(
          eq(platformCredentials.status, "active"),
          sql`${platformCredentials.user_id} IS NOT NULL`,
        ),
      );

    const byService: Record<string, number> = {};
    const connectedUserIds = new Set<string>();
    for (const row of credRows) {
      byService[row.platform] = (byService[row.platform] ?? 0) + 1;
      connectedUserIds.add(row.userId!);
    }
    const connected_users = connectedUserIds.size;

    return {
      total_users,
      connected_users,
      rate: total_users > 0 ? connected_users / total_users : 0,
      byService,
    };
  }

  // =========================================================================
  // PRE-COMPUTED READS
  // =========================================================================

  async getDailyMetrics(startDate: Date, endDate: Date): Promise<DailyMetric[]> {
    const key = CacheKeys.userMetrics.daily(
      startDate.toISOString().split("T")[0],
      endDate.toISOString().split("T")[0],
    );
    const cached = await cache.get<DailyMetric[]>(key);
    if (cached) return cached;

    const rows = await dbRead
      .select()
      .from(dailyMetrics)
      .where(and(gte(dailyMetrics.date, startDate), lt(dailyMetrics.date, endDate)))
      .orderBy(dailyMetrics.date);

    await cache.set(key, rows, CacheTTL.userMetrics.daily);
    return rows;
  }

  async getRetentionCohorts(startDate: Date, endDate: Date): Promise<RetentionCohort[]> {
    const key = CacheKeys.userMetrics.retention(
      startDate.toISOString().split("T")[0],
      endDate.toISOString().split("T")[0],
    );
    const cached = await cache.get<RetentionCohort[]>(key);
    if (cached) return cached;

    const rows = await dbRead
      .select()
      .from(retentionCohorts)
      .where(
        and(
          gte(retentionCohorts.cohort_date, startDate),
          lt(retentionCohorts.cohort_date, endDate),
        ),
      )
      .orderBy(retentionCohorts.cohort_date);

    await cache.set(key, rows, CacheTTL.userMetrics.retention);
    return rows;
  }

  // =========================================================================
  // OVERVIEW (dashboard payload)
  // =========================================================================

  async getMetricsOverview(rangeDays = 30): Promise<MetricsOverview> {
    const cacheKey = CacheKeys.userMetrics.overview(rangeDays);
    const cached = await cache.getWithSWR<MetricsOverview>(
      cacheKey,
      CacheStaleTTL.userMetrics.overview,
      () => this._buildOverview(rangeDays),
      CacheTTL.userMetrics.overview,
    );
    return cached ?? this._buildOverview(rangeDays);
  }

  private async _buildOverview(rangeDays: number): Promise<MetricsOverview> {
    const now = new Date();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const sevenDaysAgo = new Date(todayStart.getTime() - 7 * 86_400_000);
    const rangeStart = new Date(todayStart.getTime() - rangeDays * 86_400_000);

    const [
      dauResult,
      wauResult,
      mauResult,
      signupsToday,
      signups7d,
      oauthRate,
      dailyTrend,
      retention,
    ] = await Promise.all([
      this.getActiveUsers("day"),
      this.getActiveUsers("7d"),
      this.getActiveUsers("30d"),
      this.getNewSignups(todayStart, now),
      this.getNewSignups(sevenDaysAgo, now),
      this.getOAuthConnectionRate(),
      this.getDailyMetrics(rangeStart, now),
      this.getRetentionCohorts(rangeStart, now),
    ]);

    // Weighted average: totalMessages / totalDAU avoids the averaging-averages
    // problem where low-DAU days get the same weight as high-DAU days.
    const recentAll = dailyTrend.filter((d) => d.platform === null && d.dau > 0);
    const totalMessages = recentAll.reduce((s, d) => s + d.total_messages, 0);
    const totalDau = recentAll.reduce((s, d) => s + d.dau, 0);
    const avgMessagesPerUser = totalDau > 0 ? totalMessages / totalDau : 0;

    return {
      dau: dauResult.total,
      wau: wauResult.total,
      mau: mauResult.total,
      newSignupsToday: signupsToday.total,
      newSignups7d: signups7d.total,
      avgMessagesPerUser: Math.round(avgMessagesPerUser * 100) / 100,
      platformBreakdown: dauResult.byPlatform,
      oauthRate,
      dailyTrend,
      retentionCohorts: retention,
    };
  }

  // =========================================================================
  // CRON COMPUTATION (called by /api/cron/compute-metrics)
  // =========================================================================

  /**
   * Compute and upsert daily_metrics for a given date across all platforms.
   */
  async computeDailyMetrics(date: Date): Promise<void> {
    const dayStart = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);

    logger.info("[UserMetrics] Computing daily metrics", {
      date: dayStart.toISOString(),
    });

    const perPlatform: Array<MetricsPlatform> = ["web", "telegram", "discord", "imessage", "sms"];

    // Compute per-platform rows in parallel (independent queries).
    await Promise.all(
      perPlatform.map(async (platform) => {
        const { dau, totalMessages } = await this._countDayActivity(dayStart, dayEnd, platform);
        const newSignups = await this._countNewSignups(dayStart, dayEnd, platform);
        const messagesPerUser = dau > 0 ? totalMessages / dau : 0;

        await dbWrite
          .insert(dailyMetrics)
          .values({
            date: dayStart,
            platform,
            dau,
            new_signups: newSignups,
            total_messages: totalMessages,
            messages_per_user: messagesPerUser.toFixed(2),
          })
          .onConflictDoUpdate({
            target: [dailyMetrics.date, dailyMetrics.platform],
            set: {
              dau,
              new_signups: newSignups,
              total_messages: totalMessages,
              messages_per_user: messagesPerUser.toFixed(2),
            },
          });
      }),
    );

    // Compute aggregate (NULL platform) row last to avoid race with the
    // read-then-write pattern if parallelized.
    const { dau, totalMessages } = await this._countDayActivity(dayStart, dayEnd, null);
    const newSignups = await this._countNewSignups(dayStart, dayEnd, null);
    const messagesPerUser = dau > 0 ? totalMessages / dau : 0;
    const values = {
      dau,
      new_signups: newSignups,
      total_messages: totalMessages,
      messages_per_user: messagesPerUser.toFixed(2),
    };

    const existing = await dbRead
      .select()
      .from(dailyMetrics)
      .where(and(eq(dailyMetrics.date, dayStart), isNull(dailyMetrics.platform)))
      .limit(1);

    if (existing.length > 0) {
      await dbWrite.update(dailyMetrics).set(values).where(eq(dailyMetrics.id, existing[0].id));
    } else {
      await dbWrite.insert(dailyMetrics).values({ date: dayStart, platform: null, ...values });
    }
  }

  /**
   * Compute and upsert retention cohort data for a given date.
   * Updates D1 for yesterday's cohort, D7 for the cohort from 7 days ago, etc.
   *
   * Currently only writes the NULL-platform (aggregate) row. Per-platform
   * retention cohorts are supported by the schema but not yet computed.
   */
  async computeRetentionCohorts(date: Date): Promise<void> {
    const dayStart = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );

    logger.info("[UserMetrics] Computing retention cohorts", {
      date: dayStart.toISOString(),
    });

    const windows = [
      { field: "d1_retained" as const, daysAgo: 1 },
      { field: "d7_retained" as const, daysAgo: 7 },
      { field: "d30_retained" as const, daysAgo: 30 },
    ];

    // Each window targets a different cohort_date row, so they're independent.
    await Promise.all(
      windows.map(({ field, daysAgo }) => this._computeRetentionWindow(field, daysAgo, dayStart)),
    );
  }

  private async _computeRetentionWindow(
    field: "d1_retained" | "d7_retained" | "d30_retained",
    daysAgo: number,
    dayStart: Date,
  ): Promise<void> {
    const cohortDate = new Date(dayStart.getTime() - daysAgo * 86_400_000);
    const cohortEnd = new Date(cohortDate.getTime() + 86_400_000);

    const cohortConditions = and(
      sql`COALESCE(${userIdentities.is_anonymous}, false) = false`,
      gte(users.created_at, cohortDate),
      lt(users.created_at, cohortEnd),
    );

    const [sizeRow] = await dbRead
      .select({ cnt: count() })
      .from(users)
      .leftJoin(userIdentities, eq(users.id, userIdentities.user_id))
      .where(cohortConditions);
    const cohortSize = Number(sizeRow?.cnt ?? 0);

    let retainedCount = 0;
    if (cohortSize > 0) {
      const cohortUserIdSq = dbRead
        .select({ id: users.id })
        .from(users)
        .leftJoin(userIdentities, eq(users.id, userIdentities.user_id))
        .where(cohortConditions);

      retainedCount = await this._countRetainedUsers(
        cohortUserIdSq,
        dayStart,
        new Date(dayStart.getTime() + 86_400_000),
      );
    }

    const existing = await dbRead
      .select()
      .from(retentionCohorts)
      .where(and(eq(retentionCohorts.cohort_date, cohortDate), isNull(retentionCohorts.platform)))
      .limit(1);

    if (existing.length > 0) {
      await dbWrite
        .update(retentionCohorts)
        .set({
          [field]: retainedCount,
          cohort_size: cohortSize,
          updated_at: new Date(),
        })
        .where(eq(retentionCohorts.id, existing[0].id));
    } else if (cohortSize > 0) {
      await dbWrite.insert(retentionCohorts).values({
        cohort_date: cohortDate,
        platform: null,
        cohort_size: cohortSize,
        [field]: retainedCount,
      });
    }
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  private _rangeSince(range: "day" | "7d" | "30d"): Date {
    const now = new Date();
    const todayMidnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const daysBack = { day: 0, "7d": 6, "30d": 29 };
    return new Date(todayMidnight.getTime() - daysBack[range] * 86_400_000);
  }

  /**
   * Count distinct active users and total messages for a (day, platform) pair.
   *
   * All channels store messages as Eliza memories with room.source indicating
   * the channel. The PLATFORM_TO_SOURCES map converts MetricsPlatform to the
   * corresponding Eliza source values.
   */
  private async _countDayActivity(
    dayStart: Date,
    dayEnd: Date,
    platform: MetricsPlatform | null,
  ): Promise<{ dau: number; totalMessages: number }> {
    const sources = platform === null ? ALL_SOURCES : PLATFORM_TO_SOURCES[platform];

    if (sources.length === 0) {
      return { dau: 0, totalMessages: 0 };
    }

    const sourceCondition = inArray(roomTable.source, sources);

    // Count distinct message senders (not all participants) for accurate DAU.
    const [userRow] = await dbRead
      .select({
        users: countDistinct(memoryTable.entityId),
      })
      .from(memoryTable)
      .innerJoin(roomTable, eq(memoryTable.roomId, roomTable.id))
      .where(
        and(
          sourceCondition,
          gte(memoryTable.createdAt, dayStart),
          lt(memoryTable.createdAt, dayEnd),
          ne(memoryTable.entityId, roomTable.agentId),
        ),
      );

    const [msgRow] = await dbRead
      .select({
        msgs: countDistinct(memoryTable.id),
      })
      .from(memoryTable)
      .innerJoin(roomTable, eq(memoryTable.roomId, roomTable.id))
      .where(
        and(
          sourceCondition,
          gte(memoryTable.createdAt, dayStart),
          lt(memoryTable.createdAt, dayEnd),
          ne(memoryTable.entityId, roomTable.agentId),
        ),
      );

    return {
      dau: Number(userRow?.users ?? 0),
      totalMessages: Number(msgRow?.msgs ?? 0),
    };
  }

  /**
   * Count how many signups happened on a day, optionally by platform.
   */
  private async _countNewSignups(
    dayStart: Date,
    dayEnd: Date,
    platform: MetricsPlatform | null,
  ): Promise<number> {
    const conditions = [
      sql`COALESCE(ui.is_anonymous, false) = false`,
      gte(users.created_at, dayStart),
      lt(users.created_at, dayEnd),
    ];

    if (platform === "telegram") {
      conditions.push(sql`ui.telegram_id IS NOT NULL`);
    } else if (platform === "discord") {
      conditions.push(sql`ui.discord_id IS NOT NULL`);
    } else if (platform === "sms" || platform === "imessage") {
      conditions.push(sql`ui.phone_number IS NOT NULL`);
    } else if (platform === "web") {
      conditions.push(sql`ui.telegram_id IS NULL`);
      conditions.push(sql`ui.discord_id IS NULL`);
      conditions.push(sql`ui.phone_number IS NULL`);
    }

    const [r] = await dbRead
      .select({ cnt: count() })
      .from(users)
      .leftJoin(userIdentities, eq(users.id, userIdentities.user_id))
      .where(and(...conditions));

    return Number(r?.cnt ?? 0);
  }

  /**
   * Count how many users from the cohort subquery had activity on a given day.
   * Accepts a Drizzle subquery (SELECT id FROM users WHERE ...) so that
   * cohort IDs remain in the database and avoid the ~65k parameter limit.
   *
   * Uses a DB-level COUNT aggregate to avoid fetching rows into memory.
   */
  private async _countRetainedUsers(
    cohortUserIdSq: SQLWrapper | readonly string[],
    dayStart: Date,
    dayEnd: Date,
  ): Promise<number> {
    const [row] = await dbRead
      .select({ cnt: countDistinct(memoryTable.entityId) })
      .from(memoryTable)
      .innerJoin(roomTable, eq(memoryTable.roomId, roomTable.id))
      .where(
        and(
          inArray(roomTable.source, ALL_SOURCES),
          gte(memoryTable.createdAt, dayStart),
          lt(memoryTable.createdAt, dayEnd),
          ne(memoryTable.entityId, roomTable.agentId),
          inArray(memoryTable.entityId, cohortUserIdSq),
        ),
      );

    return Number(row?.cnt ?? 0);
  }
}

export const userMetricsService = new UserMetricsService();
