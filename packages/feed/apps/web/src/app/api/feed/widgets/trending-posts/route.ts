/**
 * Trending Posts Widget API
 *
 * @route GET /api/feed/widgets/trending-posts - Get trending posts
 * @access Public
 *
 * @description
 * Returns trending posts based on engagement (likes, comments, shares) and recency.
 * Uses weighted scoring algorithm with recency factor. Filters posts from last 24 hours.
 *
 * @openapi
 * /api/feed/widgets/trending-posts:
 *   get:
 *     tags:
 *       - Feed
 *     summary: Get trending posts
 *     description: Returns trending posts based on engagement and recency scoring
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximum number of posts
 *       - in: query
 *         name: timeframe
 *         schema:
 *           type: string
 *           default: 24h
 *         description: Time window for trending calculation
 *       - in: query
 *         name: minInteractions
 *         schema:
 *           type: integer
 *           default: 5
 *         description: Minimum interactions required
 *     responses:
 *       200:
 *         description: Trending posts retrieved successfully
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
 *                       authorName:
 *                         type: string
 *                       authorUsername:
 *                         type: string
 *                         nullable: true
 *                       timestamp:
 *                         type: string
 *                         format: date-time
 *                       likeCount:
 *                         type: integer
 *                       commentCount:
 *                         type: integer
 *                       shareCount:
 *                         type: integer
 *                       trendingScore:
 *                         type: number
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/feed/widgets/trending-posts?limit=5');
 * const { posts } = await response.json();
 * ```
 *
 * @see {@link /lib/validation/schemas} Validation schemas
 */

import { optionalAuth, successResponse, withErrorHandling } from '@feed/api';
import { asPublic, asUser } from '@feed/db';
import { logger, TrendingPostsQuerySchema, toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';

interface TrendingPost {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  authorUsername?: string | null;
  timestamp: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  trendingScore: number;
}

/**
 * Calculate trending score for a post
 * Formula: (likes * 2 + comments * 3 + shares * 4) * recency_factor
 * Recency factor: 1.0 for posts < 1 hour old, decreasing by 0.1 per hour, min 0.1
 */
function calculateTrendingScore(
  likeCount: number,
  commentCount: number,
  shareCount: number,
  timestamp: Date
): number {
  const now = Date.now();
  const postTime = new Date(timestamp).getTime();
  const hoursAgo = (now - postTime) / (1000 * 60 * 60);

  // Recency factor: 1.0 for < 1 hour, decreases by 0.1 per hour, min 0.1
  const recencyFactor = Math.max(0.1, 1.0 - hoursAgo * 0.1);

  // Engagement score: weighted by interaction type importance
  const engagementScore = likeCount * 2 + commentCount * 3 + shareCount * 4;

  return engagementScore * recencyFactor;
}

export const GET = withErrorHandling(async (request: NextRequest) => {
  // Validate query parameters
  const { searchParams } = new URL(request.url);
  const queryParams = {
    limit: searchParams.get('limit') || '10',
    timeframe: searchParams.get('timeframe') || '24h',
    minInteractions: searchParams.get('minInteractions') || '5',
  };
  TrendingPostsQuerySchema.parse(queryParams);
  // Get recent posts from last 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const now = new Date(); // Current time for filtering out future posts

  // Optional auth - trending posts are public but RLS still applies
  const authUser = await optionalAuth(request).catch(() => null);

  // Get posts, interactions, and users with RLS
  const { posts, allReactions, allComments, allShares, users } =
    authUser && authUser.userId
      ? await asUser(authUser, async (db) => {
          const postsList = await db.post.findMany({
            where: {
              timestamp: {
                gte: oneDayAgo,
                lte: now, // ✅ No future posts
              },
              deletedAt: null, // Filter out deleted posts
            },
            orderBy: {
              timestamp: 'desc',
            },
            take: 100, // Get more posts to calculate trending from
          });

          if (postsList.length === 0) {
            return {
              posts: [],
              allReactions: [],
              allComments: [],
              allShares: [],
              users: [],
            };
          }

          // Get interaction counts for all posts
          const postIds = postsList.map((p) => p.id);
          const [reactions, comments, shares] = await Promise.all([
            db.reaction.groupBy({
              by: ['postId'],
              where: { postId: { in: postIds }, type: 'like' },
              _count: { postId: true },
            }),
            db.comment.groupBy({
              by: ['postId'],
              where: { postId: { in: postIds } },
              _count: { postId: true },
            }),
            db.share.groupBy({
              by: ['postId'],
              where: { postId: { in: postIds } },
              _count: { postId: true },
            }),
          ]);

          // Get user data for posts
          const authorIds = [...new Set(postsList.map((p) => p.authorId))];
          const usersList = await db.user.findMany({
            where: { id: { in: authorIds } },
            select: { id: true, username: true, displayName: true },
          });

          return {
            posts: postsList,
            allReactions: reactions,
            allComments: comments,
            allShares: shares,
            users: usersList,
          };
        })
      : await asPublic(async (db) => {
          const postsList = await db.post.findMany({
            where: {
              timestamp: {
                gte: oneDayAgo,
                lte: now, // ✅ No future posts
              },
              deletedAt: null, // Filter out deleted posts
            },
            orderBy: {
              timestamp: 'desc',
            },
            take: 100, // Get more posts to calculate trending from
          });

          if (postsList.length === 0) {
            return {
              posts: [],
              allReactions: [],
              allComments: [],
              allShares: [],
              users: [],
            };
          }

          // Get interaction counts for all posts
          const postIds = postsList.map((p) => p.id);
          const [reactions, comments, shares] = await Promise.all([
            db.reaction.groupBy({
              by: ['postId'],
              where: { postId: { in: postIds }, type: 'like' },
              _count: { postId: true },
            }),
            db.comment.groupBy({
              by: ['postId'],
              where: { postId: { in: postIds } },
              _count: { postId: true },
            }),
            db.share.groupBy({
              by: ['postId'],
              where: { postId: { in: postIds } },
              _count: { postId: true },
            }),
          ]);

          // Get user data for posts
          const authorIds = [...new Set(postsList.map((p) => p.authorId))];
          const usersList = await db.user.findMany({
            where: { id: { in: authorIds } },
            select: { id: true, username: true, displayName: true },
          });

          return {
            posts: postsList,
            allReactions: reactions,
            allComments: comments,
            allShares: shares,
            users: usersList,
          };
        });

  if (posts.length === 0) {
    return successResponse({
      posts: [],
    });
  }

  // Create maps for quick lookup
  const reactionMap = new Map(
    allReactions.map((r) => {
      const count =
        typeof r._count === 'object' &&
        r._count !== null &&
        'postId' in r._count
          ? Number((r._count as { postId: number }).postId)
          : typeof r._count === 'number'
            ? r._count
            : 0;
      return [r.postId, count];
    })
  );
  const commentMap = new Map(
    allComments.map((c) => {
      const count =
        typeof c._count === 'object' &&
        c._count !== null &&
        'postId' in c._count
          ? Number((c._count as { postId: number }).postId)
          : typeof c._count === 'number'
            ? c._count
            : 0;
      return [c.postId, count];
    })
  );
  const shareMap = new Map(
    allShares.map((s) => {
      const count =
        typeof s._count === 'object' &&
        s._count !== null &&
        'postId' in s._count
          ? Number((s._count as { postId: number }).postId)
          : typeof s._count === 'number'
            ? s._count
            : 0;
      return [s.postId, count];
    })
  );
  const userMap = new Map(users.map((u) => [u.id, u]));

  // Calculate trending scores and format posts
  const trendingPosts: TrendingPost[] = posts
    .map((post) => {
      const likeCount = reactionMap.get(post.id) ?? 0;
      const commentCount = commentMap.get(post.id) ?? 0;
      const shareCount = shareMap.get(post.id) ?? 0;

      const trendingScore = calculateTrendingScore(
        likeCount,
        commentCount,
        shareCount,
        post.timestamp
      );

      const user = userMap.get(post.authorId);

      return {
        id: post.id,
        content: post.content,
        authorId: post.authorId,
        authorName: user?.displayName || user?.username || post.authorId,
        authorUsername: user?.username || null,
        timestamp: toISO(post.timestamp),
        likeCount,
        commentCount,
        shareCount,
        trendingScore,
      };
    })
    .filter((post) => post.trendingScore > 0) // Only include posts with some engagement
    .sort((a, b) => b.trendingScore - a.trendingScore) // Sort by trending score descending
    .slice(0, 5); // Top 5 trending posts

  logger.info(
    'Trending posts fetched successfully',
    { count: trendingPosts.length },
    'GET /api/feed/widgets/trending-posts'
  );

  return successResponse({
    posts: trendingPosts,
  });
});
