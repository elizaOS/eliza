import {
  and,
  asc,
  db,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  nftSnapshot,
  or,
  sql,
  users,
  whitelist,
  whitelistConfig,
} from "@feed/db";
import { UserAlphaGroupAssignmentService } from "@feed/engine";
import { logger } from "@feed/shared";
import { nanoid } from "nanoid";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WhitelistSource =
  | "snapshot_first_100"
  | "admin_manual"
  | "leaderboard";

interface AddToWhitelistParams {
  userId: string;
  source: WhitelistSource;
  reason?: string;
  grantedBy?: string;
}

interface UpdateWhitelistConfigParams {
  leaderboardRankThreshold: number | null;
  leaderboardCategory?: string;
  updatedBy?: string;
}

export const DEFAULT_WHITELIST_LEADERBOARD_THRESHOLD = 100;
export const MAX_WHITELIST_LEADERBOARD_THRESHOLD = 25_000;

export function normalizeWhitelistLeaderboardThreshold(
  value: number | null | undefined,
): number {
  if (!Number.isFinite(value) || value === undefined || value === null) {
    return DEFAULT_WHITELIST_LEADERBOARD_THRESHOLD;
  }

  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return DEFAULT_WHITELIST_LEADERBOARD_THRESHOLD;
  }

  return Math.min(normalized, MAX_WHITELIST_LEADERBOARD_THRESHOLD);
}

// ---------------------------------------------------------------------------
// Access checks
// ---------------------------------------------------------------------------

/**
 * Check if a user has an active (non-revoked) entry in the Whitelist table.
 */
export async function isUserWhitelisted(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: whitelist.id })
    .from(whitelist)
    .where(and(eq(whitelist.userId, userId), isNull(whitelist.revokedAt)))
    .limit(1);

  return Boolean(row);
}

/**
 * Check if a user qualifies for whitelist access via the leaderboard
 * rank threshold configured in WhitelistConfig.
 *
 * Computes the user's exact rank on-the-fly using the same ordering as the
 * whitelist cron. Returns false if the user cannot be ranked.
 */
export async function isUserWhitelistedByLeaderboard(
  userId: string,
): Promise<boolean> {
  const threshold = await getEffectiveWhitelistLeaderboardThreshold();
  const [user] = await db
    .select({
      id: users.id,
      reputationPoints: users.reputationPoints,
      invitePoints: users.invitePoints,
      createdAt: users.createdAt,
      isActor: users.isActor,
      isAgent: users.isAgent,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || user.isActor || user.isAgent || !user.createdAt) {
    return false;
  }

  // Count how many non-actor, non-agent users are strictly ahead using a stable
  // tiebreaker chain so the threshold matches the cron selection.
  const [result] = await db
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(
      and(
        eq(users.isActor, false),
        eq(users.isAgent, false),
        or(
          gt(users.reputationPoints, user.reputationPoints),
          and(
            eq(users.reputationPoints, user.reputationPoints),
            gt(users.invitePoints, user.invitePoints),
          ),
          and(
            eq(users.reputationPoints, user.reputationPoints),
            eq(users.invitePoints, user.invitePoints),
            lt(users.createdAt, user.createdAt),
          ),
          and(
            eq(users.reputationPoints, user.reputationPoints),
            eq(users.invitePoints, user.invitePoints),
            eq(users.createdAt, user.createdAt),
            lt(users.id, user.id),
          ),
        ),
      ),
    );

  const rank = Number(result?.count ?? 0) + 1;
  return rank <= threshold;
}

/**
 * Combined whitelist access check:
 * - active whitelist entry => allow
 * - revoked whitelist entry => deny
 * - no entry => fall back to leaderboard threshold
 */
export async function checkWhitelistAccess(
  userId: string,
): Promise<{ allowed: boolean; source: string | null }> {
  const [entry] = await db
    .select({ source: whitelist.source, revokedAt: whitelist.revokedAt })
    .from(whitelist)
    .where(eq(whitelist.userId, userId))
    .limit(1);

  // A revoked entry is a hard block — even if the user would currently qualify
  // via the leaderboard threshold, an admin revocation is intentionally permanent
  // until the row is deleted or un-revoked.
  if (entry?.revokedAt) {
    return { allowed: false, source: null };
  }

  if (entry) {
    return { allowed: true, source: entry.source };
  }

  const leaderboardAllowed = await isUserWhitelistedByLeaderboard(userId);
  if (leaderboardAllowed) {
    return { allowed: true, source: "leaderboard" };
  }

  return { allowed: false, source: null };
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Add a user to the whitelist. Uses INSERT ... ON CONFLICT for idempotency.
 *
 * If the user has an active (non-revoked) entry, returns alreadyExists: true.
 * If the user has a revoked entry, replaces it with a fresh active entry.
 */
export async function addToWhitelist({
  userId,
  source,
  reason,
  grantedBy,
}: AddToWhitelistParams): Promise<{ id: string; alreadyExists: boolean }> {
  const id = nanoid();
  const now = new Date();
  const nowISO = now.toISOString();

  const [result] = await db
    .insert(whitelist)
    .values({
      id,
      userId,
      source,
      reason: reason ?? null,
      grantedBy: grantedBy ?? null,
      grantedAt: now,
    })
    .onConflictDoUpdate({
      target: whitelist.userId,
      // Only overwrite if the existing row is revoked; otherwise leave it.
      set: {
        id: sql`CASE WHEN ${whitelist.revokedAt} IS NOT NULL THEN ${id} ELSE ${whitelist.id} END`,
        source: sql`CASE WHEN ${whitelist.revokedAt} IS NOT NULL THEN ${source} ELSE ${whitelist.source} END`,
        reason: sql`CASE WHEN ${whitelist.revokedAt} IS NOT NULL THEN ${reason ?? null} ELSE ${whitelist.reason} END`,
        grantedBy: sql`CASE WHEN ${whitelist.revokedAt} IS NOT NULL THEN ${grantedBy ?? null} ELSE ${whitelist.grantedBy} END`,
        grantedAt: sql`CASE WHEN ${whitelist.revokedAt} IS NOT NULL THEN ${nowISO}::timestamp ELSE ${whitelist.grantedAt} END`,
        revokedAt: sql`CASE WHEN ${whitelist.revokedAt} IS NOT NULL THEN NULL ELSE ${whitelist.revokedAt} END`,
      },
    })
    .returning({ id: whitelist.id });

  // An upsert always returns a row — but guard just in case.
  if (!result) throw new Error("Whitelist upsert returned no rows");

  // If the returned id matches what we tried to insert, it's a new/replaced row.
  // If it doesn't match, the row was already active and untouched.
  const alreadyExists = result.id !== id;

  // Assign default alpha groups when granting new access (async, non-blocking)
  // This ensures whitelisted users get NPC group chats immediately.
  // assignDefaultGroups is safe to call even if user already has groups or profile is partial.
  if (!alreadyExists) {
    UserAlphaGroupAssignmentService.assignDefaultGroups(userId)
      .then((assignmentResult) => {
        if (assignmentResult.groupsAssigned > 0) {
          logger.info(
            "Assigned default alpha groups to whitelisted user",
            {
              userId,
              groupsAssigned: assignmentResult.groupsAssigned,
              source,
            },
            "addToWhitelist",
          );
        }
      })
      .catch((error) => {
        logger.error(
          "Failed to assign default alpha groups to whitelisted user",
          { userId, error: String(error) },
          "addToWhitelist",
        );
      });
  }

  return { id: result.id, alreadyExists };
}

/**
 * Soft-revoke a user from the whitelist by setting revokedAt.
 */
export async function removeFromWhitelist(
  userId: string,
): Promise<{ removed: boolean }> {
  const [entry] = await db
    .select({ id: whitelist.id, revokedAt: whitelist.revokedAt })
    .from(whitelist)
    .where(eq(whitelist.userId, userId))
    .limit(1);

  if (!entry) return { removed: false };
  if (entry.revokedAt) return { removed: false }; // already revoked

  await db
    .update(whitelist)
    .set({ revokedAt: new Date() })
    .where(eq(whitelist.id, entry.id));

  return { removed: true };
}

/**
 * List all whitelist entries, optionally filtered by source.
 * Includes user info (username, walletAddress, displayName).
 */
export async function listWhitelistEntries(options?: {
  source?: WhitelistSource;
  includeRevoked?: boolean;
  search?: string;
}) {
  const sourceCondition = options?.source
    ? eq(whitelist.source, options.source)
    : undefined;

  const revokedCondition = options?.includeRevoked
    ? undefined
    : isNull(whitelist.revokedAt);

  const whereClause =
    sourceCondition && revokedCondition
      ? and(sourceCondition, revokedCondition)
      : (sourceCondition ?? revokedCondition);

  let query = db
    .select({
      id: whitelist.id,
      userId: whitelist.userId,
      source: whitelist.source,
      reason: whitelist.reason,
      grantedBy: whitelist.grantedBy,
      grantedAt: whitelist.grantedAt,
      revokedAt: whitelist.revokedAt,
      username: users.username,
      displayName: users.displayName,
      walletAddress: users.walletAddress,
      profileImageUrl: users.profileImageUrl,
    })
    .from(whitelist)
    .leftJoin(users, eq(whitelist.userId, users.id))
    .$dynamic();

  if (whereClause) {
    query = query.where(whereClause);
  }

  const results = await query.orderBy(desc(whitelist.grantedAt));

  // Apply search filter in-memory (username, userId, walletAddress)
  if (options?.search) {
    const q = options.search.toLowerCase();
    return results.filter(
      (r) =>
        r.username?.toLowerCase().includes(q) ||
        r.userId.toLowerCase().includes(q) ||
        r.walletAddress?.toLowerCase().includes(q) ||
        r.displayName?.toLowerCase().includes(q),
    );
  }

  return results;
}

/**
 * Get whitelist stats grouped by source.
 */
export async function getWhitelistStats() {
  const entries = await db
    .select({
      source: whitelist.source,
      count: sql<number>`count(*)`,
    })
    .from(whitelist)
    .where(isNull(whitelist.revokedAt))
    .groupBy(whitelist.source);

  const stats = {
    total: 0,
    snapshot_first_100: 0,
    admin_manual: 0,
    leaderboard: 0,
  };

  for (const entry of entries) {
    const count = Number(entry.count);
    stats.total += count;
    if (entry.source in stats) {
      stats[entry.source as WhitelistSource] = count;
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_ID = "default";

/**
 * Get the whitelist configuration (leaderboard threshold, etc.).
 */
export async function getWhitelistConfig() {
  const [config] = await db
    .select()
    .from(whitelistConfig)
    .where(eq(whitelistConfig.id, CONFIG_ID))
    .limit(1);

  return config ?? null;
}

export async function getEffectiveWhitelistLeaderboardThreshold(): Promise<number> {
  const config = await getWhitelistConfig();
  return normalizeWhitelistLeaderboardThreshold(
    config?.leaderboardRankThreshold,
  );
}

/**
 * Upsert the whitelist configuration.
 */
export async function updateWhitelistConfig({
  leaderboardRankThreshold,
  leaderboardCategory,
  updatedBy,
}: UpdateWhitelistConfigParams) {
  const now = new Date();

  await db
    .insert(whitelistConfig)
    .values({
      id: CONFIG_ID,
      leaderboardRankThreshold,
      leaderboardCategory: leaderboardCategory ?? "all",
      updatedAt: now,
      updatedBy: updatedBy ?? null,
    })
    .onConflictDoUpdate({
      target: whitelistConfig.id,
      set: {
        leaderboardRankThreshold,
        ...(leaderboardCategory !== undefined && { leaderboardCategory }),
        updatedAt: now,
        updatedBy: updatedBy ?? null,
      },
    });
}

// ---------------------------------------------------------------------------
// Auto-Whitelist From Leaderboard
// ---------------------------------------------------------------------------

/**
 * Resolve the cron auto-whitelist Top N from the WhitelistConfig table.
 *
 * We reuse `leaderboardRankThreshold` as the Top N knob for the daily cron.
 */
async function getAutoWhitelistTopN(): Promise<number> {
  return getEffectiveWhitelistLeaderboardThreshold();
}

/**
 * Auto-add the current Top N (category: all) to the whitelist with source
 * 'leaderboard'. This implements "reach top N at any time => keep access".
 *
 * Important: this must never re-activate revoked users. A revoked row is a
 * permanent deny for auto-whitelist; only an admin manual add can reinstate.
 */
export async function autoWhitelistCurrentTopN(): Promise<{
  topN: number;
  totalInTopN: number;
  inserted: number;
  skippedExisting: number;
  skippedRevoked: number;
}> {
  const topN = await getAutoWhitelistTopN();
  const topUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isActor, false), eq(users.isAgent, false)))
    .orderBy(
      desc(users.reputationPoints),
      desc(users.invitePoints),
      asc(users.createdAt),
      asc(users.id),
    )
    .limit(topN);
  const userIds = topUsers.map((user) => user.id);

  if (userIds.length === 0) {
    return {
      topN,
      totalInTopN: 0,
      inserted: 0,
      skippedExisting: 0,
      skippedRevoked: 0,
    };
  }

  // No need to whitelist users who already have permanent snapshot access (Top 100 end-of-2025).
  // This keeps the whitelist focused on "reached top N at any time" users.
  const snapshotRows = await db
    .select({ userId: nftSnapshot.userId })
    .from(nftSnapshot)
    .where(inArray(nftSnapshot.userId, userIds));
  const snapshotSet = new Set(snapshotRows.map((r) => r.userId));

  const existing = await db
    .select({ userId: whitelist.userId, revokedAt: whitelist.revokedAt })
    .from(whitelist)
    .where(inArray(whitelist.userId, userIds));

  const existingMap = new Map(existing.map((e) => [e.userId, e.revokedAt]));
  const toInsert = userIds.filter(
    (id) => !snapshotSet.has(id) && !existingMap.has(id),
  );

  const skippedExisting = existing.length;
  const skippedRevoked = existing.filter((e) => e.revokedAt !== null).length;

  if (toInsert.length === 0) {
    return {
      topN,
      totalInTopN: userIds.length,
      inserted: 0,
      skippedExisting,
      skippedRevoked,
    };
  }

  const now = new Date();
  const rows = toInsert.map((userId) => ({
    id: nanoid(),
    userId,
    source: "leaderboard" as WhitelistSource,
    reason: `Auto-whitelisted by leaderboard (Top ${topN})`,
    grantedBy: null,
    grantedAt: now,
  }));

  // Insert only missing users; revoked users still "exist" (unique userId),
  // so they are never re-added by this function.
  const insertedRows = await db
    .insert(whitelist)
    .values(rows)
    .onConflictDoNothing({ target: whitelist.userId })
    .returning({ userId: whitelist.userId });

  return {
    topN,
    totalInTopN: userIds.length,
    inserted: insertedRows.length,
    skippedExisting,
    skippedRevoked,
  };
}
