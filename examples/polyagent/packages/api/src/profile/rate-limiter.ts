/**
 * Rate Limiter for Backend-Signed Profile Updates
 *
 * Prevents abuse of the backend signing feature by limiting
 * how often users can update their profiles.
 */

import {
  and,
  asc,
  count,
  db,
  desc,
  eq,
  gte,
  profileUpdateLogs,
  sql,
} from "@polyagent/db";
import { generateSnowflakeId, logger } from "@polyagent/shared";

interface RateLimitConfig {
  maxUpdatesPerDay: number;
  maxUpdatesPerHour: number;
  maxUsernameChangesPerDay: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxUpdatesPerDay: 50, // 50 profile updates per day
  maxUpdatesPerHour: 10, // 10 per hour
  maxUsernameChangesPerDay: 2, // Only 2 username changes per day
};

interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfter?: number; // Seconds until retry allowed
}

/**
 * Check if user is allowed to update their profile
 */
export async function checkProfileUpdateRateLimit(
  userId: string,
  isUsernameChange: boolean,
): Promise<RateLimitResult> {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  // Count recent updates
  const [recentUpdates24hResult, recentUpdates1hResult] = await Promise.all([
    // Updates in last 24 hours
    db
      .select({ count: count() })
      .from(profileUpdateLogs)
      .where(
        and(
          eq(profileUpdateLogs.userId, userId),
          gte(profileUpdateLogs.createdAt, oneDayAgo),
        ),
      ),
    // Updates in last hour
    db
      .select({ count: count() })
      .from(profileUpdateLogs)
      .where(
        and(
          eq(profileUpdateLogs.userId, userId),
          gte(profileUpdateLogs.createdAt, oneHourAgo),
        ),
      ),
  ]);

  const recentUpdates24h = recentUpdates24hResult[0]?.count || 0;
  const recentUpdates1h = recentUpdates1hResult[0]?.count || 0;

  // Username changes in last 24 hours
  let recentUsernameChanges = 0;
  if (isUsernameChange) {
    const usernameChangesResult = await db
      .select({ count: count() })
      .from(profileUpdateLogs)
      .where(
        and(
          eq(profileUpdateLogs.userId, userId),
          gte(profileUpdateLogs.createdAt, oneDayAgo),
          sql`'username' = ANY(${profileUpdateLogs.changedFields})`,
        ),
      );
    recentUsernameChanges = usernameChangesResult[0]?.count || 0;
  }

  // Check hourly limit
  if (recentUpdates1h >= DEFAULT_CONFIG.maxUpdatesPerHour) {
    const oldestRecentUpdateResult = await db
      .select()
      .from(profileUpdateLogs)
      .where(
        and(
          eq(profileUpdateLogs.userId, userId),
          gte(profileUpdateLogs.createdAt, oneHourAgo),
        ),
      )
      .orderBy(asc(profileUpdateLogs.createdAt))
      .limit(1);

    const oldestRecentUpdate = oldestRecentUpdateResult[0];

    const retryAfter = oldestRecentUpdate
      ? Math.ceil(
          (oldestRecentUpdate.createdAt.getTime() +
            60 * 60 * 1000 -
            now.getTime()) /
            1000,
        )
      : 3600;

    logger.warn(
      "Profile update rate limit exceeded (hourly)",
      { userId, recentUpdates1h },
      "RateLimiter",
    );

    return {
      allowed: false,
      reason: `Too many profile updates. Please wait ${Math.ceil(retryAfter / 60)} minutes.`,
      retryAfter,
    };
  }

  // Check daily limit
  if (recentUpdates24h >= DEFAULT_CONFIG.maxUpdatesPerDay) {
    logger.warn(
      "Profile update rate limit exceeded (daily)",
      { userId, recentUpdates24h },
      "RateLimiter",
    );

    return {
      allowed: false,
      reason: "Daily profile update limit reached. Try again tomorrow.",
      retryAfter: 86400,
    };
  }

  // Check username change limit
  if (
    isUsernameChange &&
    recentUsernameChanges >= DEFAULT_CONFIG.maxUsernameChangesPerDay
  ) {
    logger.warn(
      "Username change rate limit exceeded",
      { userId, recentUsernameChanges },
      "RateLimiter",
    );

    return {
      allowed: false,
      reason: "You can only change your username twice per day.",
      retryAfter: 86400,
    };
  }

  return { allowed: true };
}

/**
 * Log a profile update for rate limiting and auditing
 */
export async function logProfileUpdate(
  userId: string,
  changedFields: string[],
  backendSigned: boolean,
  txHash?: string,
): Promise<void> {
  await db.insert(profileUpdateLogs).values({
    id: await generateSnowflakeId(),
    userId,
    changedFields,
    backendSigned,
    txHash: txHash || null,
    createdAt: new Date(),
  });
}

/**
 * Get recent profile update history for a user (for audit/debugging)
 */
export async function getProfileUpdateHistory(
  userId: string,
  limit = 20,
): Promise<
  Array<{
    changedFields: string[];
    backendSigned: boolean;
    txHash: string | null;
    createdAt: Date;
  }>
> {
  return await db
    .select({
      changedFields: profileUpdateLogs.changedFields,
      backendSigned: profileUpdateLogs.backendSigned,
      txHash: profileUpdateLogs.txHash,
      createdAt: profileUpdateLogs.createdAt,
    })
    .from(profileUpdateLogs)
    .where(eq(profileUpdateLogs.userId, userId))
    .orderBy(desc(profileUpdateLogs.createdAt))
    .limit(limit);
}
