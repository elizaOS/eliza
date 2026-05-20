/**
 * Favorites Feed API
 *
 * @route GET /api/posts/feed/favorites - Get posts from favorited profiles
 * @access Authenticated (optional, returns empty if not authenticated)
 *
 * @description
 * Returns posts from profiles the user has favorited. Optimized with batch queries
 * to prevent N+1 problems. Includes interaction counts and user interaction state.
 *
 * @openapi
 * /api/posts/feed/favorites:
 *   get:
 *     tags:
 *       - Posts
 *     summary: Get favorites feed
 *     description: Returns posts from favorited profiles with interaction counts
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Posts per page
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number
 *     responses:
 *       200:
 *         description: Favorites feed retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 posts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       content:
 *                         type: string
 *                       authorId:
 *                         type: string
 *                       interactions:
 *                         type: object
 *                         properties:
 *                           likeCount:
 *                             type: integer
 *                           commentCount:
 *                             type: integer
 *                           shareCount:
 *                             type: integer
 *                           isLiked:
 *                             type: boolean
 *                           isShared:
 *                             type: boolean
 *                 total:
 *                   type: integer
 *                 hasMore:
 *                   type: boolean
 *                 limit:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *       401:
 *         description: Unauthorized (returns empty feed)
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/posts/feed/favorites?limit=20&page=1', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * });
 * const { posts, total, hasMore } = await response.json();
 * ```
 *
 * @see {@link /lib/db/context} RLS context
 */

import { optionalAuth, successResponse, withErrorHandling } from '@babylon/api';
import {
  and,
  asUser,
  comments,
  count,
  desc,
  eq,
  favorites,
  inArray,
  isNull,
  lte,
  posts,
  reactions,
  shares,
} from '@babylon/db';
import { logger, PostFeedQuerySchema } from '@babylon/shared';
import type { NextRequest } from 'next/server';

/**
 * GET /api/posts/feed/favorites
 * Get posts from profiles the user has favorited
 * Query params:
 * - limit: number of posts to return (default 20, max 100)
 * - offset: pagination offset (default 0)
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  // Optional authentication - returns null if not authenticated
  const user = await optionalAuth(request);

  // If not authenticated, return empty array
  if (!user) {
    logger.info(
      'Unauthenticated request for favorites feed',
      {},
      'GET /api/posts/feed/favorites'
    );
    return successResponse({
      posts: [],
      total: 0,
      hasMore: false,
    });
  }

  // Parse and validate query parameters
  const { searchParams } = new URL(request.url);
  const queryParams = {
    limit: searchParams.get('limit'),
    page: searchParams.get('page'),
  };
  const validatedQuery = PostFeedQuerySchema.partial().parse(queryParams);
  const limit = Math.min(validatedQuery.limit || 20, 100);
  const offset = validatedQuery.page ? (validatedQuery.page - 1) * limit : 0;

  // Get favorites feed with RLS
  const result = await asUser(user, async (dbClient) => {
    // Get favorited profile IDs
    const favList = await dbClient
      .select({
        targetUserId: favorites.targetUserId,
      })
      .from(favorites)
      .where(eq(favorites.userId, user.userId));

    const favoritedUserIds = favList.map((f) => f.targetUserId);

    // If no favorites, return empty array
    if (favoritedUserIds.length === 0) {
      return { posts: [], totalCount: 0, hasMore: false };
    }

    // Get posts from favorited profiles
    // Only show posts up to current time (prevent future access)
    const now = new Date();
    const postList = await dbClient
      .select()
      .from(posts)
      .where(
        and(
          inArray(posts.authorId, favoritedUserIds),
          isNull(posts.deletedAt),
          lte(posts.timestamp, now)
        )
      )
      .orderBy(desc(posts.createdAt))
      .offset(offset)
      .limit(limit + 1);

    // Check if there are more posts
    const hasMore = postList.length > limit;
    const postsToReturn = hasMore ? postList.slice(0, limit) : postList;

    // Get total count (only count posts up to current time)
    const countResult = await dbClient
      .select({
        value: count(posts.id),
      })
      .from(posts)
      .where(
        and(
          inArray(posts.authorId, favoritedUserIds),
          lte(posts.timestamp, now)
        )
      );
    const totalCount = countResult[0]?.value ?? 0;

    // Get interaction counts and user states - OPTIMIZED: Batch queries instead of N+1
    const postIds = postsToReturn.map((p) => p.id);

    // Execute all queries in parallel (5 queries total instead of 5N)
    const [allReactions, allComments, allShares, userReactions, userShares] =
      await Promise.all([
        dbClient
          .select({
            postId: reactions.postId,
            count: count(reactions.id),
          })
          .from(reactions)
          .where(
            and(inArray(reactions.postId, postIds), eq(reactions.type, 'like'))
          )
          .groupBy(reactions.postId),
        dbClient
          .select({
            postId: comments.postId,
            count: count(comments.id),
          })
          .from(comments)
          .where(inArray(comments.postId, postIds))
          .groupBy(comments.postId),
        dbClient
          .select({
            postId: shares.postId,
            count: count(shares.id),
          })
          .from(shares)
          .where(inArray(shares.postId, postIds))
          .groupBy(shares.postId),
        dbClient
          .select({
            postId: reactions.postId,
          })
          .from(reactions)
          .where(
            and(
              inArray(reactions.postId, postIds),
              eq(reactions.userId, user.userId),
              eq(reactions.type, 'like')
            )
          ),
        dbClient
          .select({
            postId: shares.postId,
          })
          .from(shares)
          .where(
            and(inArray(shares.postId, postIds), eq(shares.userId, user.userId))
          ),
      ]);

    // Create lookup maps for O(1) access
    const reactionMap = new Map(
      allReactions.map((r) => [r.postId, Number(r.count)])
    );
    const commentMap = new Map(
      allComments.map((c) => [c.postId, Number(c.count)])
    );
    const shareMap = new Map(allShares.map((s) => [s.postId, Number(s.count)]));
    const userReactionSet = new Set(userReactions.map((r) => r.postId));
    const userShareSet = new Set(userShares.map((s) => s.postId));

    // Transform posts synchronously using lookup maps
    const transformedPosts = postsToReturn.map((post) => ({
      id: post.id,
      content: post.content,
      createdAt: post.createdAt,
      timestamp: post.timestamp,
      authorId: post.authorId,
      gameId: post.gameId,
      dayNumber: post.dayNumber,
      interactions: {
        likeCount: reactionMap.get(post.id) ?? 0,
        commentCount: commentMap.get(post.id) ?? 0,
        shareCount: shareMap.get(post.id) ?? 0,
        isLiked: userReactionSet.has(post.id),
        isShared: userShareSet.has(post.id),
      },
    }));

    return { posts: transformedPosts, totalCount, hasMore };
  });

  logger.info(
    'Favorites feed fetched successfully',
    {
      userId: user.userId,
      count: result.posts.length,
      total: result.totalCount,
    },
    'GET /api/posts/feed/favorites'
  );

  return successResponse({
    posts: result.posts,
    total: result.totalCount,
    hasMore: result.hasMore,
    limit,
    offset,
  });
});
