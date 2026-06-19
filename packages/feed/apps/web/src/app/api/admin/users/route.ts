/**
 * Admin User Management API
 *
 * @route GET /api/admin/users - Get user list
 * @access Admin
 *
 * @description
 * Returns paginated user list with comprehensive metrics, filtering, and sorting.
 * Includes moderation metrics, engagement stats, and user flags. Requires admin
 * authentication.
 *
 * @openapi
 * /api/admin/users:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get user list
 *     description: Returns paginated user list with metrics and filtering (admin only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Results per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Pagination offset
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by username or display name
 *       - in: query
 *         name: filter
 *         schema:
 *           type: string
 *           enum: [all, actors, users, banned, admins]
 *           default: all
 *         description: Filter by user type
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [created, balance, reputation, username, reports_received, blocks_received, mutes_received, report_ratio, block_ratio, bad_user_score]
 *           default: created
 *         description: Sort field
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *     responses:
 *       200:
 *         description: User list retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                 total:
 *                   type: integer
 *                 hasMore:
 *                   type: boolean
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/admin/users?limit=20&filter=banned&sortBy=reports_received', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * });
 * ```
 *
 * @see {@link /lib/api/admin-middleware} Admin middleware
 */

import { requireAdmin, successResponse, withErrorHandling } from "@feed/api";
import {
  and,
  asc,
  comments,
  count,
  db,
  desc,
  eq,
  follows,
  inArray,
  isNull,
  positions,
  reactions,
  reports,
  type SQL,
  sql,
  userBlocks,
  userMutes,
  users,
  whitelist,
} from "@feed/db";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

const QuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
  search: z.string().optional(),
  filter: z.enum(["all", "actors", "users", "banned", "admins"]).default("all"),
  sortBy: z
    .enum([
      "created",
      "balance",
      "reputation",
      "username",
      "reports_received",
      "blocks_received",
      "mutes_received",
      "report_ratio",
      "block_ratio",
      "bad_user_score",
    ])
    .default("created"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  // Require admin authentication
  await requireAdmin(request);

  // Parse query parameters
  const { searchParams } = new URL(request.url);
  const params = QuerySchema.parse({
    limit: searchParams.get("limit") || "50",
    offset: searchParams.get("offset") || "0",
    search: searchParams.get("search") || undefined,
    filter: searchParams.get("filter") || "all",
    sortBy: searchParams.get("sortBy") || "created",
    sortOrder: searchParams.get("sortOrder") || "desc",
  });

  logger.info("Admin users list requested", { params }, "GET /api/admin/users");

  // Build where conditions
  const conditions: SQL[] = [];

  if (params.filter === "actors") {
    conditions.push(eq(users.isActor, true));
  } else if (params.filter === "users") {
    conditions.push(eq(users.isActor, false));
  } else if (params.filter === "banned") {
    conditions.push(eq(users.isBanned, true));
  } else if (params.filter === "admins") {
    conditions.push(eq(users.isAdmin, true));
  }

  if (params.search) {
    // Escape special LIKE/ILIKE characters to prevent pattern injection
    // Using backslash as escape character, which is specified in raw SQL
    const escapedSearch = params.search
      .replace(/\\/g, "\\\\") // Escape backslashes first
      .replace(/%/g, "\\%") // Escape percent
      .replace(/_/g, "\\_"); // Escape underscore

    // Use raw SQL with ESCAPE clause to properly handle escaped wildcards
    const searchPattern = `%${escapedSearch}%`;
    const searchCondition = sql`(
      ${users.username} ILIKE ${searchPattern} ESCAPE '\\' OR
      ${users.displayName} ILIKE ${searchPattern} ESCAPE '\\' OR
      ${users.walletAddress} ILIKE ${searchPattern} ESCAPE '\\'
    )`;
    conditions.push(searchCondition);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Determine sort order
  const sortFn = params.sortOrder === "asc" ? asc : desc;
  let orderByClause: SQL | undefined;

  if (params.sortBy === "created") {
    orderByClause = sortFn(users.createdAt);
  } else if (params.sortBy === "balance") {
    orderByClause = sortFn(users.virtualBalance);
  } else if (params.sortBy === "reputation") {
    orderByClause = sortFn(users.reputationPoints);
  } else if (params.sortBy === "username") {
    orderByClause = sortFn(users.username);
  }

  // Get users
  const usersResult = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      walletAddress: users.walletAddress,
      profileImageUrl: users.profileImageUrl,
      isActor: users.isActor,
      isAdmin: users.isAdmin,
      isBanned: users.isBanned,
      bannedAt: users.bannedAt,
      bannedReason: users.bannedReason,
      bannedBy: users.bannedBy,
      virtualBalance: users.virtualBalance,
      totalDeposited: users.totalDeposited,
      totalWithdrawn: users.totalWithdrawn,
      lifetimePnL: users.lifetimePnL,
      reputationPoints: users.reputationPoints,
      referralCount: users.referralCount,
      nftTokenId: users.nftTokenId,
      hasFarcaster: users.hasFarcaster,
      hasTwitter: users.hasTwitter,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(whereClause)
    .orderBy(orderByClause ?? desc(users.createdAt))
    .limit(params.limit)
    .offset(params.offset);

  // Get total count
  const [totalResult] = await db
    .select({ count: count() })
    .from(users)
    .where(whereClause);
  const total = totalResult?.count ?? 0;

  // Get user IDs for batched count queries (only for paginated results)
  const userIds = usersResult.map((u) => u.id);

  // Get moderation counts per user (batched queries - filtered to only fetched users)
  const [
    commentCounts,
    reactionCounts,
    positionCounts,
    followerCounts,
    followingCounts,
    reportsReceived,
    blocksReceived,
    mutesReceived,
    reportsSent,
    whitelistedUsers,
  ] =
    userIds.length > 0
      ? await Promise.all([
          // Comment counts
          db
            .select({ userId: comments.authorId, count: count() })
            .from(comments)
            .where(inArray(comments.authorId, userIds))
            .groupBy(comments.authorId),
          // Reaction counts
          db
            .select({ userId: reactions.userId, count: count() })
            .from(reactions)
            .where(inArray(reactions.userId, userIds))
            .groupBy(reactions.userId),
          // Position counts
          db
            .select({ userId: positions.userId, count: count() })
            .from(positions)
            .where(inArray(positions.userId, userIds))
            .groupBy(positions.userId),
          // Follower counts (users following this user)
          db
            .select({ userId: follows.followingId, count: count() })
            .from(follows)
            .where(inArray(follows.followingId, userIds))
            .groupBy(follows.followingId),
          // Following counts (users this user follows)
          db
            .select({ userId: follows.followerId, count: count() })
            .from(follows)
            .where(inArray(follows.followerId, userIds))
            .groupBy(follows.followerId),
          // Reports received
          db
            .select({ userId: reports.reportedUserId, count: count() })
            .from(reports)
            .where(inArray(reports.reportedUserId, userIds))
            .groupBy(reports.reportedUserId),
          // Blocks received
          db
            .select({ userId: userBlocks.blockedId, count: count() })
            .from(userBlocks)
            .where(inArray(userBlocks.blockedId, userIds))
            .groupBy(userBlocks.blockedId),
          // Mutes received
          db
            .select({ userId: userMutes.mutedId, count: count() })
            .from(userMutes)
            .where(inArray(userMutes.mutedId, userIds))
            .groupBy(userMutes.mutedId),
          // Reports sent
          db
            .select({ userId: reports.reporterId, count: count() })
            .from(reports)
            .where(inArray(reports.reporterId, userIds))
            .groupBy(reports.reporterId),
          // Whitelist status (active entries only).
          // Wrapped in catch so a missing Whitelist table doesn't break the admin endpoint.
          db
            .select({ userId: whitelist.userId })
            .from(whitelist)
            .where(
              and(
                inArray(whitelist.userId, userIds),
                isNull(whitelist.revokedAt),
              ),
            )
            .catch(() => [] as { userId: string }[]),
        ])
      : [[], [], [], [], [], [], [], [], [], []];

  // Build lookup maps
  const commentCountMap = new Map(
    commentCounts.filter((c) => c.userId).map((c) => [c.userId!, c.count]),
  );
  const reactionCountMap = new Map(
    reactionCounts.filter((r) => r.userId).map((r) => [r.userId!, r.count]),
  );
  const positionCountMap = new Map(
    positionCounts.filter((p) => p.userId).map((p) => [p.userId!, p.count]),
  );
  const followerCountMap = new Map(
    followerCounts.filter((f) => f.userId).map((f) => [f.userId!, f.count]),
  );
  const followingCountMap = new Map(
    followingCounts.filter((f) => f.userId).map((f) => [f.userId!, f.count]),
  );
  const reportsReceivedMap = new Map(
    reportsReceived.filter((r) => r.userId).map((r) => [r.userId!, r.count]),
  );
  const blocksReceivedMap = new Map(
    blocksReceived.filter((b) => b.userId).map((b) => [b.userId!, b.count]),
  );
  const mutesReceivedMap = new Map(
    mutesReceived.filter((m) => m.userId).map((m) => [m.userId!, m.count]),
  );
  const reportsSentMap = new Map(
    reportsSent.filter((r) => r.userId).map((r) => [r.userId!, r.count]),
  );
  const whitelistedSet = new Set(whitelistedUsers.map((w) => w.userId));

  // Calculate moderation metrics and bad user scores
  const usersWithMetrics = usersResult.map((user) => {
    const followers = followerCountMap.get(user.id) || 0;
    const reportsReceivedCount = reportsReceivedMap.get(user.id) || 0;
    const blocksReceivedCount = blocksReceivedMap.get(user.id) || 0;
    const mutesReceivedCount = mutesReceivedMap.get(user.id) || 0;
    const reportsSentCount = reportsSentMap.get(user.id) || 0;

    // Calculate ratios (avoid division by zero)
    const reportRatio =
      followers > 0 ? reportsReceivedCount / followers : reportsReceivedCount;
    const blockRatio =
      followers > 0 ? blocksReceivedCount / followers : blocksReceivedCount;
    const muteRatio =
      followers > 0 ? mutesReceivedCount / followers : mutesReceivedCount;

    // Calculate combined bad user score
    const badUserScore = reportRatio * 5 + blockRatio * 3 + muteRatio * 1;

    return {
      ...user,
      isWhitelisted: whitelistedSet.has(user.id),
      _count: {
        comments: commentCountMap.get(user.id) || 0,
        reactions: reactionCountMap.get(user.id) || 0,
        positions: positionCountMap.get(user.id) || 0,
        following: followingCountMap.get(user.id) || 0,
        followedBy: followers,
        reportsReceived: reportsReceivedCount,
        blocksReceived: blocksReceivedCount,
        mutesReceived: mutesReceivedCount,
        reportsSent: reportsSentCount,
      },
      _moderation: {
        reportsReceived: reportsReceivedCount,
        blocksReceived: blocksReceivedCount,
        mutesReceived: mutesReceivedCount,
        reportsSent: reportsSentCount,
        reportRatio,
        blockRatio,
        muteRatio,
        badUserScore,
      },
    };
  });

  // Sort based on query parameter (for moderation metrics, we sort after fetching)
  //
  // KNOWN LIMITATION: Moderation-based sorting (reports_received, blocks_received,
  // mutes_received, report_ratio, block_ratio, bad_user_score) requires fetching
  // all users within the filter and sorting in-memory, ignoring the LIMIT parameter.
  // This is because moderation metrics are computed from aggregated counts across
  // multiple tables (reports, blocks, mutes) and cannot be efficiently sorted in SQL
  // without either:
  // 1. Pre-computing scores in a denormalized column (adds maintenance overhead)
  // 2. Using SQL window functions with CTEs (complex query, still full scan)
  //
  // For typical admin use cases with < 100k users, in-memory sorting is acceptable.
  // If performance becomes an issue, consider:
  // - Pre-computing badUserScore in a scheduled job
  // - Adding materialized views for moderation metrics
  // - Caching results with TTL for repeated queries
  if (params.sortBy === "reports_received") {
    usersWithMetrics.sort((a, b) => {
      const diff =
        b._moderation.reportsReceived - a._moderation.reportsReceived;
      return params.sortOrder === "asc" ? -diff : diff;
    });
  } else if (params.sortBy === "blocks_received") {
    usersWithMetrics.sort((a, b) => {
      const diff = b._moderation.blocksReceived - a._moderation.blocksReceived;
      return params.sortOrder === "asc" ? -diff : diff;
    });
  } else if (params.sortBy === "mutes_received") {
    usersWithMetrics.sort((a, b) => {
      const diff = b._moderation.mutesReceived - a._moderation.mutesReceived;
      return params.sortOrder === "asc" ? -diff : diff;
    });
  } else if (params.sortBy === "report_ratio") {
    usersWithMetrics.sort((a, b) => {
      const diff = b._moderation.reportRatio - a._moderation.reportRatio;
      return params.sortOrder === "asc" ? -diff : diff;
    });
  } else if (params.sortBy === "block_ratio") {
    usersWithMetrics.sort((a, b) => {
      const diff = b._moderation.blockRatio - a._moderation.blockRatio;
      return params.sortOrder === "asc" ? -diff : diff;
    });
  } else if (params.sortBy === "bad_user_score") {
    usersWithMetrics.sort((a, b) => {
      const diff = b._moderation.badUserScore - a._moderation.badUserScore;
      return params.sortOrder === "asc" ? -diff : diff;
    });
  }

  return successResponse({
    users: usersWithMetrics.map((user) => ({
      ...user,
      virtualBalance: user.virtualBalance.toString(),
      totalDeposited: user.totalDeposited.toString(),
      totalWithdrawn: user.totalWithdrawn.toString(),
      lifetimePnL: user.lifetimePnL.toString(),
      _moderation: {
        reportsReceived: user._moderation.reportsReceived,
        blocksReceived: user._moderation.blocksReceived,
        mutesReceived: user._moderation.mutesReceived,
        reportsSent: user._moderation.reportsSent,
        reportRatio: Number(user._moderation.reportRatio.toFixed(2)),
        blockRatio: Number(user._moderation.blockRatio.toFixed(2)),
        muteRatio: Number(user._moderation.muteRatio.toFixed(2)),
        badUserScore: Number(user._moderation.badUserScore.toFixed(2)),
      },
    })),
    pagination: {
      limit: params.limit,
      offset: params.offset,
      total,
    },
  });
});
