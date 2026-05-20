/**
 * User Registry API
 *
 * @description
 * Public registry of all registered users and agents on the Feed platform.
 * Provides comprehensive user listings with filtering, sorting, pagination,
 * and optional on-chain verification filtering. Includes reputation scores
 * and activity statistics.
 *
 * **Features:**
 * - Public user directory
 * - On-chain verification filtering
 * - Flexible sorting (by reputation, PnL, creation date)
 * - Pagination support
 * - Activity statistics (positions, comments, reactions)
 * - On-chain reputation scores (when applicable)
 * - RLS-compatible (respects user visibility settings)
 *
 * **Use Cases:**
 * - User discovery and networking
 * - Reputation leaderboards
 * - On-chain verification lookup
 * - Community member browsing
 * - Agent/user directory
 *
 * @openapi
 * /api/registry:
 *   get:
 *     tags:
 *       - Registry
 *     summary: Get user registry
 *     description: Returns paginated list of all registered users/agents with filtering and sorting options
 *     parameters:
 *       - in: query
 *         name: onChainOnly
 *         schema:
 *           type: boolean
 *         description: Filter for only on-chain registered users
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [createdAt, reputationPoints, lifetimePnL, username]
 *         description: Sort field
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 100
 *         description: Results per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: User registry
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       username:
 *                         type: string
 *                       displayName:
 *                         type: string
 *                       bio:
 *                         type: string
 *                       profileImageUrl:
 *                         type: string
 *                       walletAddress:
 *                         type: string
 *                       nftTokenId:
 *                         type: string
 *                       virtualBalance:
 *                         type: string
 *                       lifetimePnL:
 *                         type: string
 *                       reputation:
 *                         type: number
 *                         nullable: true
 *                       stats:
 *                         type: object
 *                         properties:
 *                           positions:
 *                             type: integer
 *                           comments:
 *                             type: integer
 *                           reactions:
 *                             type: integer
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 *
 * @example
 * ```typescript
 * // Get all users
 * const response = await fetch('/api/registry?limit=50&sortBy=reputationPoints');
 * const { users, pagination } = await response.json();
 *
 * // Get only on-chain users
 * const onChainUsers = await fetch('/api/registry?onChainOnly=true&sortBy=lifetimePnL');
 *
 * // Display top traders
 * users.forEach(user => {
 *   console.log(`${user.displayName}: ${user.lifetimePnL} PnL, Rep: ${user.reputation}`);
 * });
 * ```
 *
 * @see {@link /lib/services/reputation-service} Reputation service
 * @see {@link /lib/db/context} RLS context
 */

import {
  addPublicReadHeaders,
  MarketReputationService,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import type { DrizzleClient } from "@feed/db";
import { asPublic, asUser } from "@feed/db";
import { logger, RegistryQuerySchema } from "@feed/shared";
import type { NextRequest } from "next/server";
/**
 * GET /api/registry
 * Fetch all registered users with optional filtering
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);

  // Parse and validate query parameters
  const queryParams = {
    onChainOnly: searchParams.get("onChainOnly") ?? undefined,
    sortBy: searchParams.get("sortBy") ?? undefined,
    sortOrder: searchParams.get("sortOrder") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
    offset: searchParams.get("offset") ?? undefined,
  };
  const filters = RegistryQuerySchema.parse(queryParams);

  const {
    error,
    user: authUser,
    rateLimitInfo,
  } = await publicRateLimit(request);
  if (error) return error;

  // Build where clause
  void filters.onChainOnly; // onChainOnly filter removed (column dropped)
  const where = {};

  // Build order by clause
  const orderBy = filters.sortBy
    ? {
        [filters.sortBy]: filters.sortOrder,
      }
    : { createdAt: "desc" as const };

  // Fetch users from database with RLS (public registry, no auth required)
  const dbOperation = async (db: DrizzleClient) => {
    const usersList = await db.user.findMany({
      where,
      orderBy,
      take: filters.limit,
      skip: filters.offset,
    });

    // Get total count for pagination
    const count = await db.user.count({ where });

    // Get counts for each user
    const userIds = usersList.map((u) => u.id);
    const [positionCounts, commentCounts, reactionCounts] = await Promise.all([
      Promise.all(
        userIds.map((id) => db.position.count({ where: { userId: id } })),
      ),
      Promise.all(
        userIds.map((id) => db.comment.count({ where: { authorId: id } })),
      ),
      Promise.all(
        userIds.map((id) => db.reaction.count({ where: { userId: id } })),
      ),
    ]);

    const usersWithCounts = usersList.map((user, index) => ({
      ...user,
      _counts: {
        positions: positionCounts[index] ?? 0,
        comments: commentCounts[index] ?? 0,
        reactions: reactionCounts[index] ?? 0,
      },
    }));

    return { users: usersWithCounts, totalCount: count };
  };

  const { users, totalCount } = authUser?.userId
    ? await asUser(authUser, dbOperation)
    : await asPublic(dbOperation);

  const usersWithReputation = await Promise.all(
    users.map(async (user) => {
      let reputation: number | null = null;
      if (user.nftTokenId) {
        reputation = await MarketReputationService.getOnChainReputation(
          user.id,
        );
      }

      return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        bio: user.bio,
        profileImageUrl: user.profileImageUrl,
        walletAddress: user.walletAddress,
        isActor: user.isActor,
        nftTokenId: user.nftTokenId,
        createdAt: user.createdAt,
        virtualBalance: user.virtualBalance.toString(),
        lifetimePnL: user.lifetimePnL.toString(),
        reputation,
        stats: {
          positions: user._counts.positions,
          comments: user._counts.comments,
          reactions: user._counts.reactions,
        },
      };
    }),
  );

  logger.info(
    "Registry fetched successfully",
    {
      total: totalCount,
      returned: usersWithReputation.length,
      onChainOnly: filters.onChainOnly,
    },
    "GET /api/registry",
  );

  const res = successResponse({
    users: usersWithReputation,
    pagination: {
      total: totalCount,
      limit: filters.limit || 100,
      offset: filters.offset || 0,
      hasMore: (filters.offset || 0) + usersWithReputation.length < totalCount,
    },
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
