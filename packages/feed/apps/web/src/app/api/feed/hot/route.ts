/**
 * Hot Posts Feed API
 *
 * @route GET /api/feed/hot - Get hot/trending posts
 * @access Public
 *
 * @description
 * Returns the hottest posts from the last 24 hours, ranked by engagement.
 * Uses a scoring algorithm that weights different engagement types and applies
 * an age penalty to favor recent content.
 *
 * **Scoring Algorithm:**
 * ```
 * score = likes + (comments * 2) + (shares * 3) - (hours_old * 0.5)
 * ```
 *
 * @openapi
 * /api/feed/hot:
 *   get:
 *     tags:
 *       - Feed
 *     summary: Get hot posts feed
 *     description: Returns the hottest posts from the last 24 hours ranked by engagement score.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Maximum posts to return
 *     responses:
 *       200:
 *         description: Hot posts feed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
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
 *                       timestamp:
 *                         type: string
 *                         format: date-time
 *                       likeCount:
 *                         type: integer
 *                       commentCount:
 *                         type: integer
 *                       shareCount:
 *                         type: integer
 *                       hotScore:
 *                         type: number
 *                 limit:
 *                   type: integer
 *
 * @example
 * ```typescript
 * const { posts } = await fetch('/api/feed/hot?limit=20').then(r => r.json());
 * posts.forEach(post => console.log(`${post.authorName}: ${post.content} (score: ${post.hotScore})`));
 * ```
 */

import {
  getCacheOrFetch,
  optionalAuth,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import {
  and,
  comments,
  count,
  db,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  posts,
  reactions,
  shares,
  users,
} from "@feed/db";
import { StaticDataRegistry } from "@feed/engine";
import { logger, toISO } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

const QuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(50),
});

/**
 * Hot post with engagement scores and author info
 */
interface HotPost {
  id: string;
  content: string;
  fullContent: string | null;
  articleTitle: string | null;
  category: string | null;
  imageUrl: string | null;
  type: string | null;
  timestamp: string;
  createdAt: string;
  authorId: string;
  authorName: string;
  authorUsername: string | null;
  authorProfileImageUrl: string | null;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  hotScore: number;
}

/**
 * Hot post with user-specific interaction status
 */
interface HotPostWithUserStatus extends HotPost {
  isLiked: boolean;
  isShared: boolean;
}

// Age penalty: 0.5 points deducted per hour old
const AGE_PENALTY_PER_HOUR = 0.5;
// Engagement weights
const LIKE_WEIGHT = 1;
const COMMENT_WEIGHT = 2;
const SHARE_WEIGHT = 3;
// Maximum candidates to fetch before scoring and filtering
const MAX_CANDIDATE_POSTS = 500;
// Time window for hot posts (24 hours in milliseconds)
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Calculate hot score for a post
 */
function calculateHotScore(
  likeCount: number,
  commentCount: number,
  shareCount: number,
  timestamp: Date,
): number {
  const now = new Date();
  const hoursOld = (now.getTime() - timestamp.getTime()) / (1000 * 60 * 60);

  const engagementScore =
    likeCount * LIKE_WEIGHT +
    commentCount * COMMENT_WEIGHT +
    shareCount * SHARE_WEIGHT;

  const agePenalty = hoursOld * AGE_PENALTY_PER_HOUR;

  return Math.max(0, engagementScore - agePenalty);
}

/**
 * Converts a date value to ISO string format, handling various input types.
 * STRICT: Throws an error for invalid or unparseable dates instead of masking with current time.
 *
 * Use `validateDateWithFallback` when a graceful fallback is needed instead.
 */
function toISOStringStrict(date: Date | string | null | undefined): string {
  if (date === null || date === undefined) {
    throw new Error(
      "Invalid date input in toISOStringStrict: date is null or undefined",
    );
  }
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) {
      throw new Error(
        "Invalid date input in toISOStringStrict: Date object is invalid",
      );
    }
    return toISO(date);
  }
  if (typeof date === "string") {
    // Always parse and validate string dates - don't trust format heuristics
    const parsed = new Date(date);
    if (!Number.isNaN(parsed.getTime())) {
      return toISO(parsed);
    }
    throw new Error(
      `Invalid date input in toISOStringStrict: unparseable string "${date}"`,
    );
  }
  throw new Error(
    `Invalid date input in toISOStringStrict: unexpected type ${typeof date}`,
  );
}

/**
 * Validates a date value and returns a valid Date, falling back to current time if invalid.
 * Logs a warning when fallback is used.
 */
function validateDateWithFallback(
  rawValue: Date | string | null | undefined,
  fieldName: string,
  postId: string,
): Date {
  const date = rawValue instanceof Date ? rawValue : new Date(rawValue ?? "");
  if (Number.isNaN(date.getTime())) {
    logger.warn(
      `Invalid ${fieldName} for post ${postId}, falling back to current time`,
      {
        postId,
        [`original${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)}`]:
          rawValue,
      },
      "HotPostsAPI",
    );
    return new Date();
  }
  return date;
}

/**
 * GET /api/feed/hot
 *
 * Returns the hottest posts from the last 24 hours, ranked by engagement score.
 * Caches results for 60 seconds to reduce database load.
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  // Optional auth for user-specific data (isLiked, isShared)
  const user = await optionalAuth(request).catch((err) => {
    logger.debug("optionalAuth failed", { error: err }, "HotPostsAPI");
    return null;
  });

  const { searchParams } = new URL(request.url);
  const params = QuerySchema.parse({
    limit: searchParams.get("limit") || "50",
  });

  // Cache key includes limit but not user (engagement data is the same for all)
  const cacheKey = `feed:hot:v1:${params.limit}`;

  const result = await getCacheOrFetch(
    cacheKey,
    async () => {
      const now = new Date();
      const twentyFourHoursAgo = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS);

      // Get posts from the last 24 hours that are visible (not deleted, not in future)
      const recentPosts = await db
        .select({
          id: posts.id,
          content: posts.content,
          authorId: posts.authorId,
          timestamp: posts.timestamp,
          createdAt: posts.createdAt,
          type: posts.type,
          articleTitle: posts.articleTitle,
          fullContent: posts.fullContent,
          category: posts.category,
          imageUrl: posts.imageUrl,
        })
        .from(posts)
        .where(
          and(
            isNull(posts.deletedAt),
            gte(posts.timestamp, twentyFourHoursAgo),
            lte(posts.timestamp, now),
            // Exclude comments/replies - only top-level posts
            isNull(posts.commentOnPostId),
            isNull(posts.parentCommentId),
          ),
        )
        .orderBy(desc(posts.timestamp))
        .limit(MAX_CANDIDATE_POSTS); // Get more than needed to allow for scoring

      if (recentPosts.length === 0) {
        return {
          posts: [],
          postIds: [],
        };
      }

      const postIds = recentPosts.map((p) => p.id);

      // Get engagement counts in parallel
      const [reactionCounts, commentCounts, shareCounts] = await Promise.all([
        db
          .select({
            postId: reactions.postId,
            count: count(),
          })
          .from(reactions)
          .where(
            and(inArray(reactions.postId, postIds), eq(reactions.type, "like")),
          )
          .groupBy(reactions.postId),
        db
          .select({
            postId: comments.postId,
            count: count(),
          })
          .from(comments)
          .where(
            and(inArray(comments.postId, postIds), isNull(comments.deletedAt)),
          )
          .groupBy(comments.postId),
        db
          .select({
            postId: shares.postId,
            count: count(),
          })
          .from(shares)
          .where(inArray(shares.postId, postIds))
          .groupBy(shares.postId),
      ]);

      // Create maps for quick lookup
      const reactionMap = new Map(
        reactionCounts.map((r) => [r.postId, Number(r.count)]),
      );
      const commentMap = new Map(
        commentCounts.map((c) => [c.postId, Number(c.count)]),
      );
      const shareMap = new Map(
        shareCounts.map((s) => [s.postId, Number(s.count)]),
      );

      // Get author information
      const authorIds = [...new Set(recentPosts.map((p) => p.authorId))];
      const authorUsers = await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          profileImageUrl: users.profileImageUrl,
        })
        .from(users)
        .where(inArray(users.id, authorIds));

      const userMap = new Map(authorUsers.map((u) => [u.id, u]));

      // Calculate hot score for each post and format
      const scoredPosts = recentPosts.map((post) => {
        const likeCount = reactionMap.get(post.id) ?? 0;
        const commentCount = commentMap.get(post.id) ?? 0;
        const shareCount = shareMap.get(post.id) ?? 0;

        // Validate and convert dates for scoring
        const validTimestamp = validateDateWithFallback(
          post.timestamp,
          "timestamp",
          post.id,
        );
        const validCreatedAt = validateDateWithFallback(
          post.createdAt,
          "createdAt",
          post.id,
        );

        const hotScore = calculateHotScore(
          likeCount,
          commentCount,
          shareCount,
          validTimestamp,
        );

        // Get author details
        const authorUser = userMap.get(post.authorId);
        const actorRecord = StaticDataRegistry.getActor(post.authorId);

        let authorName = post.authorId;
        let authorUsername: string | null = null;
        let authorProfileImageUrl: string | null = null;

        if (actorRecord) {
          authorName = actorRecord.name;
          authorUsername = actorRecord.username || actorRecord.id;
          authorProfileImageUrl = actorRecord.profileImageUrl || null;
        } else if (authorUser) {
          authorName =
            authorUser.displayName || authorUser.username || post.authorId;
          authorUsername = authorUser.username;
          authorProfileImageUrl = authorUser.profileImageUrl;
        }

        return {
          id: post.id,
          content: post.content,
          fullContent: post.fullContent,
          articleTitle: post.articleTitle,
          category: post.category,
          imageUrl: post.imageUrl,
          type: post.type,
          timestamp: toISOStringStrict(validTimestamp),
          createdAt: toISOStringStrict(validCreatedAt),
          authorId: post.authorId,
          authorName,
          authorUsername,
          authorProfileImageUrl,
          likeCount,
          commentCount,
          shareCount,
          hotScore: Math.round(hotScore * 100) / 100, // Round to 2 decimal places
        };
      });

      // Sort by hot score descending
      scoredPosts.sort((a, b) => b.hotScore - a.hotScore);

      // Take top N
      const topPosts = scoredPosts.slice(0, params.limit);

      return {
        posts: topPosts,
        postIds: topPosts.map((p) => p.id),
      };
    },
    {
      namespace: "feed",
      ttl: 60, // Cache for 60 seconds
    },
  );

  // If user is authenticated, add their like/share status
  // NOTE: User-specific data (isLiked/isShared) bypasses cache on every authenticated request.
  // For high-traffic scenarios, consider: per-user cache with shorter TTL, client-side
  // optimistic updates, or bloom filter pre-filtering. Current approach is fine for moderate traffic.
  let postsWithUserStatus: HotPost[] | HotPostWithUserStatus[] = result.posts;

  if (user?.userId && result.postIds.length > 0) {
    const [userLikes, userShares] = await Promise.all([
      db
        .select({ postId: reactions.postId })
        .from(reactions)
        .where(
          and(
            inArray(reactions.postId, result.postIds),
            eq(reactions.userId, user.userId),
            eq(reactions.type, "like"),
          ),
        ),
      db
        .select({ postId: shares.postId })
        .from(shares)
        .where(
          and(
            inArray(shares.postId, result.postIds),
            eq(shares.userId, user.userId),
          ),
        ),
    ]);

    const likedPostIds = new Set(userLikes.map((l) => l.postId));
    const sharedPostIds = new Set(userShares.map((s) => s.postId));

    postsWithUserStatus = result.posts.map((post: HotPost) => ({
      ...post,
      isLiked: likedPostIds.has(post.id),
      isShared: sharedPostIds.has(post.id),
    }));
  }

  return successResponse({
    success: true,
    posts: postsWithUserStatus,
    limit: params.limit,
  });
});
