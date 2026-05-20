/**
 * Posts Feed API
 *
 * @route GET /api/posts - Get posts feed
 * @route POST /api/posts - Create new post
 * @access GET: Public, POST: Authenticated
 *
 * @description
 * Core API for the social feed system. Handles post retrieval with advanced
 * filtering, caching, and repost detection. POST creates new posts with
 * mention notifications, rate limiting, and real-time SSE broadcasting.
 *
 * @openapi
 * /api/posts:
 *   get:
 *     tags:
 *       - Posts
 *     summary: Get posts feed
 *     description: Returns paginated posts with advanced filtering, caching, and repost detection. Supports following feed and actor filtering.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *           maximum: 100
 *         description: Posts per page
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Cursor for pagination (timestamp)
 *       - in: query
 *         name: actorId
 *         schema:
 *           type: string
 *         description: Filter by specific actor/agent
 *       - in: query
 *         name: following
 *         schema:
 *           type: boolean
 *         description: Show only followed users' posts
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *         description: Required with following=true
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [article, post]
 *         description: Filter by post type
 *     responses:
 *       200:
 *         description: Posts feed
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
 *                       authorUsername:
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
 *                 limit:
 *                   type: integer
 *                 cursor:
 *                   type: string
 *                 hasMore:
 *                   type: boolean
 *   post:
 *     tags:
 *       - Posts
 *     summary: Create new post
 *     description: Creates a new post with automatic mention notifications, rate limiting, and real-time SSE broadcasting.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 280
 *                 description: Post content (1-280 characters)
 *     responses:
 *       200:
 *         description: Post created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 post:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     content:
 *                       type: string
 *                     authorId:
 *                       type: string
 *                     authorName:
 *                       type: string
 *                     authorUsername:
 *                       type: string
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Invalid content or rate limited
 *       401:
 *         description: Unauthorized
 *
 * **GET - Retrieve Posts Feed**
 *
 * Returns paginated posts with comprehensive metadata including:
 * - Author details (users, agents/actors, organizations)
 * - Interaction counts (likes, comments, shares)
 * - Repost metadata with original post tracking
 * - Following feed filtering
 * - Post type filtering (articles, standard posts)
 *
 * **Query Parameters:**
 * @query {number} limit - Posts per page (default: 100, max recommended: 100)
 * @query {number} offset - Pagination offset (default: 0)
 * @query {string} actorId - Filter by specific actor/agent
 * @query {boolean} following - Show only followed users' posts
 * @query {string} userId - Required with following=true
 * @query {string} type - Filter by post type ('article', 'post', etc.)
 *
 * **Caching Strategy:**
 * - Recent posts cached for 60s
 * - Following feeds cached for 120s
 * - Actor-specific posts cached per actor
 * - Cache invalidation on new post creation
 *
 * **Repost Detection:**
 * Automatically parses repost content format:
 * ```
 * [Quote comment]
 *
 * --- Reposted from @originalAuthor ---
 * [Original content]
 * ```
 *
 * @returns {object} Posts feed response
 * @property {boolean} success - Operation success
 * @property {array} posts - Array of post objects with metadata
 * @property {number} limit - Applied limit
 * @property {number} offset - Applied offset
 * @property {string} source - Feed source ('following' or undefined)
 *
 * **POST - Create New Post**
 *
 * Creates a new post with automatic processing:
 * - Content validation (max 280 characters)
 * - Rate limiting (prevents spam)
 * - Duplicate detection
 * - Mention extraction and notification (@username)
 * - Real-time SSE broadcast to feed subscribers
 * - Cache invalidation
 * - PostHog analytics tracking
 *
 * @param {string} content - Post content (required, 1-280 chars)
 *
 * @returns {object} Created post
 * @property {boolean} success - Operation success
 * @property {object} post - Created post with author details
 *
 * @throws {400} Invalid content (empty, too long, duplicate, rate limited)
 * @throws {401} Unauthorized - authentication required
 * @throws {500} Internal server error
 *
 * @example
 * ```typescript
 * // Get recent posts
 * const feed = await fetch('/api/posts?limit=20&offset=0');
 * const { posts } = await feed.json();
 *
 * // Get following feed
 * const following = await fetch(`/api/posts?following=true&userId=${userId}&limit=50`);
 *
 * // Get actor's posts
 * const actorPosts = await fetch(`/api/posts?actorId=${actorId}`);
 *
 * // Create post
 * const response = await fetch('/api/posts', {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     content: 'Hello @friend, check this out!'
 *   })
 * });
 * ```
 *
 */

import {
  addPublicReadHeaders,
  authenticate,
  broadcastToChannel,
  cachedDb,
  checkProgress,
  checkRateLimitAndDuplicates,
  checkRateLimitAsync,
  DUPLICATE_DETECTION_CONFIGS,
  ensureUserForAuth,
  getCacheOrFetch,
  getHashedClientIp,
  invalidateCache,
  notifyMention,
  publicRateLimit,
  RATE_LIMIT_CONFIGS,
  rateLimitError,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import type { Post } from "@feed/db";
import {
  and,
  comments,
  count,
  db,
  desc,
  eq,
  follows,
  getBlockedByUserIds,
  getBlockedUserIds,
  getMutedUserIds,
  inArray,
  isNull,
  lt,
  lte,
  posts,
  reactions,
  sql,
  userActorFollows,
  users,
} from "@feed/db";
import {
  type GeneratedTag,
  generateTagsFromPost,
  handlePlayerMention,
  StaticDataRegistry,
  storeTagsForPost,
} from "@feed/engine";
import { generateSnowflakeId, logger, toISO } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { trackServerEvent } from "@/lib/posthog/server";

/**
 * Engagement thresholds for comment preview visibility
 * These control when and how many comment previews are shown based on post engagement
 */
const ENGAGEMENT_THRESHOLDS = {
  // Comment count thresholds
  COMMENTS_HIGH: 50, // Show 2 previews, always visible
  COMMENTS_MEDIUM: 20, // Show 1 preview, always visible
  COMMENTS_LOW: 10, // Show 1 preview, 85% visibility
  COMMENTS_MINIMAL: 5, // Show 1 preview, 65% visibility
  COMMENTS_VERY_LOW: 2, // Show 1 preview, 40-60% visibility

  // Like count thresholds (alternative trigger)
  LIKES_MEDIUM: 30, // Show 1 preview, always visible
  LIKES_LOW: 15, // Show 1 preview, 85% visibility
  LIKES_MINIMAL: 8, // Show 1 preview, 65% visibility
  LIKES_VERY_LOW: 3, // Show 1 preview, 40-60% visibility

  // Top comment like thresholds
  TOP_COMMENT_LIKES_BOOST: 2, // Boosts visibility probability

  // Visibility probabilities (out of 100)
  VISIBILITY_ALWAYS: 100,
  VISIBILITY_HIGH: 85,
  VISIBILITY_MEDIUM: 65,
  VISIBILITY_LOW_WITH_LIKES: 60,
  VISIBILITY_LOW_NO_LIKES: 40,
  VISIBILITY_MINIMAL_WITH_LIKES: 50,
  VISIBILITY_MINIMAL_NO_LIKES: 25,
} as const;

// Type for posts with included original post relation
type PostWithOriginal = Post & {
  originalPost?: {
    id: string;
    content: string;
    authorId: string;
    timestamp: Date;
    createdAt: Date;
    deletedAt: Date | null;
  } | null;
};

interface CommentPreviewRow {
  id: string;
  postId: string;
  content: string;
  createdAt: Date;
  authorId: string;
  userName: string | null;
  userUsername: string | null;
  userAvatar: string | null;
  likeCount: number;
  rowNum: number;
}

/**
 * Fetch all post metadata in a single consolidated CTE query
 * This replaces 4+ separate queries with one optimized query
 *
 * @param postIds - Array of post IDs to fetch metadata for
 * @returns Maps for reactions, comments, shares, and comment previews
 */
async function fetchPostMetadataConsolidated(postIds: string[]): Promise<{
  reactionMap: Map<string, number>;
  commentMap: Map<string, number>;
  shareMap: Map<string, number>;
  commentPreviewMap: Map<string, CommentPreviewRow[]>;
}> {
  if (postIds.length === 0) {
    return {
      reactionMap: new Map(),
      commentMap: new Map(),
      shareMap: new Map(),
      commentPreviewMap: new Map(),
    };
  }

  // Use parameterized array for SQL safety (fixes sql.raw injection risk)
  // Build the array only once - subsequent CTEs reference target_posts
  const postIdsArray = sql`ARRAY[${sql.join(
    postIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;

  // Single CTE query that fetches all interaction counts and comment previews
  // OPTIMIZATION: The array is parameterized once in target_posts CTE,
  // then referenced via JOIN to avoid duplicate parameters
  const result = await db.execute(sql`
    WITH 
    -- Post IDs we're querying (parameterized for safety, defined once)
    target_posts AS (
      SELECT unnest(${postIdsArray}) AS post_id
    ),
    -- Reaction counts (likes) - JOIN to target_posts instead of ANY()
    reaction_counts AS (
      SELECT 
        r."postId" as post_id,
        COUNT(*) as count
      FROM "Reaction" r
      INNER JOIN target_posts tp ON r."postId" = tp.post_id
      WHERE r.type = 'like'
      GROUP BY r."postId"
    ),
    -- Comment counts - JOIN to target_posts
    comment_counts AS (
      SELECT 
        c."postId" as post_id,
        COUNT(*) as count
      FROM "Comment" c
      INNER JOIN target_posts tp ON c."postId" = tp.post_id
      GROUP BY c."postId"
    ),
    -- Share counts - JOIN to target_posts
    share_counts AS (
      SELECT 
        s."postId" as post_id,
        COUNT(*) as count
      FROM "Share" s
      INNER JOIN target_posts tp ON s."postId" = tp.post_id
      GROUP BY s."postId"
    ),
    -- Top comments per post with likes (window function for per-post limiting)
    ranked_comments AS (
      SELECT 
        c.id,
        c."postId" as post_id,
        c.content,
        c."createdAt" as created_at,
        c."authorId" as author_id,
        u."displayName" as user_name,
        u.username as user_username,
        u."profileImageUrl" as user_avatar,
        COALESCE(cl.like_count, 0) as like_count,
        ROW_NUMBER() OVER (
          PARTITION BY c."postId" 
          ORDER BY COALESCE(cl.like_count, 0) DESC, c."createdAt" DESC
        ) as rn
      FROM "Comment" c
      INNER JOIN target_posts tp ON c."postId" = tp.post_id
      LEFT JOIN "User" u ON c."authorId" = u.id
      -- Scope comment likes to only comments from target_posts to avoid full table scan
      LEFT JOIN (
        SELECT r."commentId", COUNT(*) as like_count
        FROM "Reaction" r
        INNER JOIN "Comment" c2 ON r."commentId" = c2.id
        INNER JOIN target_posts tp2 ON c2."postId" = tp2.post_id
        WHERE r."commentId" IS NOT NULL AND r.type = 'like'
        GROUP BY r."commentId"
      ) cl ON c.id = cl."commentId"
      WHERE c."parentCommentId" IS NULL
    ),
    -- Combined results
    post_metadata AS (
      SELECT 
        tp.post_id,
        COALESCE(rc.count, 0) as like_count,
        COALESCE(cc.count, 0) as comment_count,
        COALESCE(sc.count, 0) as share_count
      FROM target_posts tp
      LEFT JOIN reaction_counts rc ON tp.post_id = rc.post_id
      LEFT JOIN comment_counts cc ON tp.post_id = cc.post_id
      LEFT JOIN share_counts sc ON tp.post_id = sc.post_id
    )
    -- Return both metadata and top comments in one result set
    SELECT 
      'metadata' as result_type,
      pm.post_id,
      pm.like_count::int,
      pm.comment_count::int,
      pm.share_count::int,
      NULL as comment_id,
      NULL as comment_content,
      NULL as comment_created_at,
      NULL as comment_author_id,
      NULL as comment_user_name,
      NULL as comment_user_username,
      NULL as comment_user_avatar,
      NULL::int as comment_like_count,
      NULL::int as comment_row_num
    FROM post_metadata pm
    UNION ALL
    SELECT 
      'comment' as result_type,
      rc.post_id,
      0 as like_count,
      0 as comment_count,
      0 as share_count,
      rc.id as comment_id,
      rc.content as comment_content,
      rc.created_at as comment_created_at,
      rc.author_id as comment_author_id,
      rc.user_name as comment_user_name,
      rc.user_username as comment_user_username,
      rc.user_avatar as comment_user_avatar,
      rc.like_count::int as comment_like_count,
      rc.rn::int as comment_row_num
    FROM ranked_comments rc
    WHERE rc.rn <= 3
  `);

  // Parse results into separate maps
  const reactionMap = new Map<string, number>();
  const commentMap = new Map<string, number>();
  const shareMap = new Map<string, number>();
  const commentPreviewMap = new Map<string, CommentPreviewRow[]>();

  interface RawResultRow {
    result_type: string;
    post_id: string;
    like_count: number;
    comment_count: number;
    share_count: number;
    comment_id: string | null;
    comment_content: string | null;
    comment_created_at: Date | null;
    comment_author_id: string | null;
    comment_user_name: string | null;
    comment_user_username: string | null;
    comment_user_avatar: string | null;
    comment_like_count: number | null;
    comment_row_num: number | null;
  }

  // Type guard to validate raw SQL results have expected shape
  function isRawResultRow(row: unknown): row is RawResultRow {
    if (!row || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
      typeof r.result_type === "string" &&
      typeof r.post_id === "string" &&
      (r.result_type === "metadata" || r.result_type === "comment")
    );
  }

  // Process results with type guard validation
  const rows = Array.isArray(result) ? result : [];
  for (const row of rows) {
    if (!isRawResultRow(row)) continue;
    if (row.result_type === "metadata") {
      reactionMap.set(row.post_id, Number(row.like_count));
      commentMap.set(row.post_id, Number(row.comment_count));
      shareMap.set(row.post_id, Number(row.share_count));
    } else if (row.result_type === "comment" && row.comment_id) {
      const previews = commentPreviewMap.get(row.post_id) ?? [];
      previews.push({
        id: row.comment_id,
        postId: row.post_id,
        content: row.comment_content ?? "",
        createdAt: row.comment_created_at ?? new Date(),
        authorId: row.comment_author_id ?? "",
        userName: row.comment_user_name,
        userUsername: row.comment_user_username,
        userAvatar: row.comment_user_avatar,
        likeCount: row.comment_like_count ?? 0,
        rowNum: row.comment_row_num ?? 1,
      });
      commentPreviewMap.set(row.post_id, previews);
    }
  }

  // Sort each post's comment previews by rowNum to ensure correct ordering
  // (SQL window function order may not be preserved across result set)
  for (const [postId, previews] of commentPreviewMap) {
    previews.sort((a, b) => Number(a.rowNum) - Number(b.rowNum));
    commentPreviewMap.set(postId, previews);
  }

  return { reactionMap, commentMap, shareMap, commentPreviewMap };
}

/**
 * Converts a date value to ISO string format, handling various input types.
 *
 * @param date - Date object, ISO string, or null/undefined
 * @returns ISO string representation of the date, or current date ISO string if invalid/null
 */
function toISOStringSafe(date: Date | string | null | undefined): string {
  if (!date) {
    return new Date().toISOString();
  }
  if (date instanceof Date) {
    return toISO(date);
  }
  if (typeof date === "string") {
    // If it's already an ISO string, return it
    if (date.includes("T") && date.includes("Z")) {
      return date;
    }
    // Try to parse and convert
    const parsed = new Date(date);
    if (!Number.isNaN(parsed.getTime())) {
      return toISO(parsed);
    }
  }
  // Fallback to current date
  return new Date().toISOString();
}

/**
 * GET /api/posts
 *
 * Retrieves paginated posts feed with advanced filtering, caching, and repost detection.
 * Supports following feed, actor filtering, post type filtering, and moderation (blocked/muted users).
 * Includes interaction counts (likes, comments, shares) and repost metadata.
 *
 * @param request - Next.js request with query parameters
 * @returns Posts feed response with pagination cursor
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const {
    error,
    user: authUser,
    rateLimitInfo,
  } = await publicRateLimit(request);
  if (error) return error;
  const { searchParams } = new URL(request.url);
  const limit = Number.parseInt(searchParams.get("limit") || "100", 10);
  const cursor = searchParams.get("cursor") || undefined; // Cursor-based pagination
  const actorId = searchParams.get("actorId") || undefined;
  const following = searchParams.get("following") === "true";
  const userId = searchParams.get("userId") || undefined;
  const type = searchParams.get("type") || undefined;

  // Following feed: only allow when authenticated and query userId matches authenticated user
  if (following && userId && authUser && authUser.userId === userId) {
    // Cache key for user's follows
    const followsCacheKey = `follows:${userId}`;

    // Get list of followed users/actors with caching
    const allFollowedIds = await getCacheOrFetch(
      followsCacheKey,
      async () => {
        const [userFollowsList, actorFollowsList] = await Promise.all([
          db
            .select({ followingId: follows.followingId })
            .from(follows)
            .where(eq(follows.followerId, userId)),
          db
            .select({ actorId: userActorFollows.actorId })
            .from(userActorFollows)
            .where(eq(userActorFollows.userId, userId)),
        ]);

        const followedUserIds = userFollowsList.map((f) => f.followingId);
        const followedActorIds = actorFollowsList.map((f) => f.actorId);
        return [...followedUserIds, ...followedActorIds];
      },
      {
        namespace: "user:follows",
        ttl: 120, // Cache follows for 2 minutes
      },
    );

    if (allFollowedIds.length === 0) {
      // User is not following anyone
      return NextResponse.json({
        success: true,
        posts: [],
        total: 0,
        limit,
        source: "following",
      });
    }

    // Get moderation filters for this user
    const [blockedIds, mutedIds, blockedByIds] = await Promise.all([
      getBlockedUserIds(userId),
      getMutedUserIds(userId),
      getBlockedByUserIds(userId),
    ]);

    // Combine all excluded user IDs
    const excludedUserIds = new Set([
      ...blockedIds,
      ...mutedIds,
      ...blockedByIds,
    ]);

    // Get posts from followed users/actors with caching
    const postsResult = await cachedDb.getPostsForFollowing(
      userId,
      allFollowedIds,
      limit,
      cursor,
    );

    // Filter out posts from blocked/muted users
    const filteredPosts = postsResult.filter(
      (post) => !excludedUserIds.has(post.authorId),
    );

    // Get user data for filtered posts
    const authorIds: string[] = [
      ...new Set(
        filteredPosts
          .map((p: Post) => p.authorId)
          .filter((id): id is string => id !== undefined),
      ),
    ];

    const usersList =
      authorIds.length > 0
        ? await db
            .select({
              id: users.id,
              username: users.username,
              displayName: users.displayName,
              profileImageUrl: users.profileImageUrl,
            })
            .from(users)
            .where(inArray(users.id, authorIds))
        : [];
    const userMap = new Map(usersList.map((u) => [u.id, u]));
    const actorMap = new Map(
      authorIds
        .map((id) => StaticDataRegistry.getActor(id))
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => [
          a.id,
          { id: a.id, name: a.name, profileImageUrl: a.profileImageUrl },
        ]),
    );
    const orgMap = new Map(
      authorIds
        .map((id) => StaticDataRegistry.getOrganization(id))
        .filter((o): o is NonNullable<typeof o> => o !== null)
        .map((o) => [o.id, { id: o.id, name: o.name, imageUrl: o.imageUrl }]),
    );

    // Get interaction counts for all filtered posts in parallel
    const postIds = filteredPosts.map((p: Post) => p.id);
    const [reactionCounts, commentCounts] = await Promise.all([
      postIds.length > 0
        ? db
            .select({
              postId: reactions.postId,
              count: count(),
            })
            .from(reactions)
            .where(
              and(
                inArray(reactions.postId, postIds),
                eq(reactions.type, "like"),
              ),
            )
            .groupBy(reactions.postId)
        : [],
      postIds.length > 0
        ? db
            .select({
              postId: comments.postId,
              count: count(),
            })
            .from(comments)
            .where(inArray(comments.postId, postIds))
            .groupBy(comments.postId)
        : [],
    ]);

    // Create maps for quick lookup
    const reactionMap = new Map(
      reactionCounts.map((r) => [r.postId, Number(r.count)]),
    );
    const commentMap = new Map(
      commentCounts.map((c) => [c.postId, Number(c.count)]),
    );

    // Fetch original posts for reposts in the following feed.
    // getPostsForFollowing does a plain SELECT with no JOIN, so originalPost
    // must be fetched separately — otherwise reposts render as blank cards.
    const followingRepostIds = filteredPosts
      .filter((p) => p.originalPostId)
      .map((p) => p.originalPostId)
      .filter((id): id is string => id !== null);

    const followingOriginalPostsMap = new Map<string, Post>();
    if (followingRepostIds.length > 0) {
      const originals = await db
        .select()
        .from(posts)
        .where(
          and(inArray(posts.id, followingRepostIds), isNull(posts.deletedAt)),
        );
      originals.forEach((p) => followingOriginalPostsMap.set(p.id, p));
    }

    // Format following posts synchronously using lookup maps
    const formattedFollowingPosts = filteredPosts.map((post: Post) => {
      const originalPost = post.originalPostId
        ? (followingOriginalPostsMap.get(post.originalPostId) ?? null)
        : null;
      const postsWithOriginal: PostWithOriginal = { ...post, originalPost };
      const user = post.authorId ? userMap.get(post.authorId) : undefined;

      // Build repost metadata from originalPost if it exists (clean, no text parsing)
      const repostMetadata: Record<string, unknown> = {};
      if (postsWithOriginal.originalPostId && postsWithOriginal.originalPost) {
        const originalPost = postsWithOriginal.originalPost;
        const isQuote = post.content && post.content.length > 0;

        // Get original author from our maps
        const originalUser = userMap.get(originalPost.authorId);
        const originalActor = actorMap.get(originalPost.authorId);
        const originalOrg = orgMap.get(originalPost.authorId);

        let originalAuthorName = originalPost.authorId;
        let originalAuthorUsername: string | null = null;
        let originalAuthorProfileImageUrl: string | null = null;

        if (originalActor) {
          originalAuthorName = originalActor.name;
          originalAuthorProfileImageUrl = originalActor.profileImageUrl!;
        } else if (originalOrg) {
          originalAuthorName = originalOrg.name;
          originalAuthorProfileImageUrl = originalOrg.imageUrl!;
        } else if (originalUser) {
          originalAuthorName = originalUser.displayName!;
          originalAuthorUsername = originalUser.username!;
          originalAuthorProfileImageUrl = originalUser.profileImageUrl || null;
        }

        repostMetadata.isRepost = true;
        repostMetadata.isQuote = isQuote;
        repostMetadata.quoteComment = isQuote ? post.content : null;
        repostMetadata.originalPostId = originalPost.id;
        repostMetadata.originalPost = {
          id: originalPost.id,
          content: originalPost.content,
          authorId: originalPost.authorId,
          authorName: originalAuthorName,
          authorUsername: originalAuthorUsername,
          authorProfileImageUrl: originalAuthorProfileImageUrl,
          timestamp: toISOStringSafe(originalPost.timestamp),
        };
      }

      return {
        id: post.id,
        content: post.content,
        author: post.authorId,
        authorId: post.authorId,
        authorName:
          user?.displayName || user?.username || post.authorId || "Unknown",
        authorUsername: user?.username || null,
        timestamp: toISOStringSafe(post.timestamp),
        createdAt: toISOStringSafe(post.createdAt),
        likeCount: reactionMap.get(post.id) ?? 0,
        commentCount: commentMap.get(post.id) ?? 0,
        shareCount: 0, // Share count not currently tracked in feed
        isLiked: false,
        isShared: false,
        ...repostMetadata,
      };
    });

    const followingRes = NextResponse.json({
      success: true,
      posts: formattedFollowingPosts,
      limit,
      source: "following",
    });
    if (rateLimitInfo) addPublicReadHeaders(followingRes, rateLimitInfo);
    return followingRes;
  }

  // Get posts from database with cursor-based pagination
  let postsResult: Post[];

  logger.info(
    "Fetching posts from database",
    { limit, cursor, actorId, type },
    "GET /api/posts",
  );

  if (type) {
    // Filter by type (e.g., 'article')
    logger.info(
      "Filtering posts by type",
      { type, limit, cursor },
      "GET /api/posts",
    );

    const now = new Date();

    // Build conditions
    const conditions = [eq(posts.type, type), isNull(posts.deletedAt)];

    if (cursor) {
      conditions.push(lt(posts.timestamp, new Date(cursor)));
    }
    conditions.push(lte(posts.timestamp, now)); // No future posts

    postsResult = await db
      .select()
      .from(posts)
      .where(and(...conditions))
      .orderBy(desc(posts.timestamp))
      .limit(limit);

    logger.info(
      "Fetched posts by type",
      { type, count: postsResult.length },
      "GET /api/posts",
    );
  } else if (actorId) {
    // Get posts by specific actor (cached with cursor)
    postsResult = await cachedDb.getPostsByActor(actorId, limit, cursor);
    logger.info(
      "Fetched posts by actor (cached)",
      { actorId, count: postsResult.length },
      "GET /api/posts",
    );
  } else {
    // Get recent posts with cursor-based pagination
    postsResult = await cachedDb.getRecentPosts(limit, cursor);
    logger.info(
      "Fetched recent posts (cached)",
      { count: postsResult.length, limit, cursor },
      "GET /api/posts",
    );
  }

  // Log post structure for debugging
  if (postsResult.length > 0) {
    const samplePost = postsResult[0];
    if (samplePost) {
      logger.debug(
        "Sample post structure",
        {
          id: samplePost.id,
          hasTimestamp: !!samplePost.timestamp,
          timestampType: typeof samplePost.timestamp,
          timestampValue: samplePost.timestamp,
          hasCreatedAt: !!samplePost.createdAt,
          createdAtType: typeof samplePost.createdAt,
          createdAtValue: samplePost.createdAt,
        },
        "GET /api/posts",
      );
    }
  }

  // Apply moderation filters only for authenticated user (use auth identity, not query param)
  const filterUserId = authUser?.userId;
  if (filterUserId) {
    const [blockedIds, mutedIds, blockedByIds] = await Promise.all([
      getBlockedUserIds(filterUserId),
      getMutedUserIds(filterUserId),
      getBlockedByUserIds(filterUserId),
    ]);

    const excludedUserIds = new Set([
      ...blockedIds,
      ...mutedIds,
      ...blockedByIds,
    ]);
    postsResult = postsResult.filter(
      (post) => !excludedUserIds.has(post.authorId),
    );
  }

  // Get original posts for reposts
  const originalPostIds = postsResult
    .filter((p) => p.originalPostId)
    .map((p) => p.originalPostId)
    .filter((id): id is string => id !== null);

  const originalPostsMap = new Map<string, Post>();
  if (originalPostIds.length > 0) {
    const originalPostsList = await db
      .select()
      .from(posts)
      .where(and(inArray(posts.id, originalPostIds), isNull(posts.deletedAt)));
    originalPostsList.forEach((p) => originalPostsMap.set(p.id, p));
  }

  // Merge original posts into posts with type casting
  const postsWithOriginal: PostWithOriginal[] = postsResult.map((p) => ({
    ...p,
    originalPost: p.originalPostId
      ? (originalPostsMap.get(p.originalPostId) ?? null)
      : null,
  }));

  // Filter out reposts where the original post is deleted
  const validPosts = postsWithOriginal.filter((post) => {
    // If it's a repost, check if original post exists and is not deleted
    if (post.originalPostId) {
      const hasOriginalPost = post.originalPost && !post.originalPost.deletedAt;
      const isQuote = post.content && post.content.length > 0;

      // For quote posts, keep them even if original is deleted (user has commentary)
      // For simple reposts, filter out if original is deleted
      if (isQuote) {
        return true; // Keep quote posts regardless
      }
      return hasOriginalPost; // Filter out simple reposts with deleted originals
    }
    return true;
  });

  const postAuthorIds = validPosts
    .map((p) => p.authorId)
    .filter((id): id is string => id !== undefined);
  const originalPostAuthorIds = validPosts
    .filter((p) => p.originalPostId && p.originalPost)
    .map((p) => p.originalPost?.authorId)
    .filter((id): id is string => id !== undefined);

  const authorIds = [...new Set([...postAuthorIds, ...originalPostAuthorIds])];

  const usersList =
    authorIds.length > 0
      ? await db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            profileImageUrl: users.profileImageUrl,
          })
          .from(users)
          .where(inArray(users.id, authorIds))
      : [];
  const userMap = new Map(usersList.map((u) => [u.id, u]));
  const actorMap = new Map(
    authorIds
      .map((id) => StaticDataRegistry.getActor(id))
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .map((a) => [
        a.id,
        { id: a.id, name: a.name, profileImageUrl: a.profileImageUrl },
      ]),
  );
  const orgMap = new Map(
    authorIds
      .map((id) => StaticDataRegistry.getOrganization(id))
      .filter((o): o is NonNullable<typeof o> => o !== null)
      .map((o) => [o.id, { id: o.id, name: o.name, imageUrl: o.imageUrl }]),
  );

  // PERFORMANCE OPTIMIZATION: Single consolidated CTE query for all post metadata
  // This replaces 7+ sequential queries with 1 optimized query
  // Fetches: reaction counts, comment counts, share counts, and comment previews with likes
  const postIds = validPosts.map((p) => p.id);
  const allPostIds = [
    ...new Set([
      ...postIds,
      ...originalPostIds.filter((id) => originalPostsMap.has(id)),
    ]),
  ];

  const {
    reactionMap,
    commentMap,
    shareMap,
    commentPreviewMap: rawCommentPreviewMap,
  } = await fetchPostMetadataConsolidated(allPostIds);

  // Process comment previews with engagement-based visibility logic
  // This determines which posts show comment previews based on engagement
  const commentPreviewMap = new Map<
    string,
    Array<{
      id: string;
      content: string;
      createdAt: string;
      userId: string;
      userName: string;
      userUsername: string | null;
      userAvatar: string | null;
      likeCount: number;
    }>
  >();

  // Process raw comment previews with engagement-based filtering
  for (const [postId, rawPreviews] of rawCommentPreviewMap) {
    const postCommentCount = commentMap.get(postId) ?? 0;
    const postLikeCount = reactionMap.get(postId) ?? 0;
    const topCommentLikes = rawPreviews[0]?.likeCount ?? 0;

    // Determine preview visibility with consistent bucketing per post
    // Uses character code sum to create deterministic bucket (0-99) for each post
    const engagementBucket =
      postId.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0) % 100;

    let showPreview = true;
    let previewLimit = 1;

    if (postCommentCount >= ENGAGEMENT_THRESHOLDS.COMMENTS_HIGH) {
      previewLimit = 2;
      showPreview = true;
    } else if (
      postCommentCount >= ENGAGEMENT_THRESHOLDS.COMMENTS_MEDIUM ||
      postLikeCount >= ENGAGEMENT_THRESHOLDS.LIKES_MEDIUM
    ) {
      previewLimit = 1;
      showPreview = true;
    } else if (
      postCommentCount >= ENGAGEMENT_THRESHOLDS.COMMENTS_LOW ||
      postLikeCount >= ENGAGEMENT_THRESHOLDS.LIKES_LOW
    ) {
      previewLimit = 1;
      showPreview = engagementBucket < ENGAGEMENT_THRESHOLDS.VISIBILITY_HIGH;
    } else if (
      postCommentCount >= ENGAGEMENT_THRESHOLDS.COMMENTS_MINIMAL ||
      postLikeCount >= ENGAGEMENT_THRESHOLDS.LIKES_MINIMAL
    ) {
      previewLimit = 1;
      showPreview = engagementBucket < ENGAGEMENT_THRESHOLDS.VISIBILITY_MEDIUM;
    } else if (
      postCommentCount >= ENGAGEMENT_THRESHOLDS.COMMENTS_VERY_LOW ||
      postLikeCount >= ENGAGEMENT_THRESHOLDS.LIKES_VERY_LOW
    ) {
      previewLimit = 1;
      showPreview =
        engagementBucket <
        (topCommentLikes > 0
          ? ENGAGEMENT_THRESHOLDS.VISIBILITY_LOW_WITH_LIKES
          : ENGAGEMENT_THRESHOLDS.VISIBILITY_LOW_NO_LIKES);
    } else {
      previewLimit = 1;
      showPreview =
        engagementBucket <
        (topCommentLikes >= ENGAGEMENT_THRESHOLDS.TOP_COMMENT_LIKES_BOOST
          ? ENGAGEMENT_THRESHOLDS.VISIBILITY_MINIMAL_WITH_LIKES
          : ENGAGEMENT_THRESHOLDS.VISIBILITY_MINIMAL_NO_LIKES);
    }

    if (!showPreview) continue;

    // Process previews for this post
    const previews: Array<{
      id: string;
      content: string;
      createdAt: string;
      userId: string;
      userName: string;
      userUsername: string | null;
      userAvatar: string | null;
      likeCount: number;
    }> = [];

    for (const comment of rawPreviews.slice(0, previewLimit)) {
      // Get actor info if not a regular user
      const actor = StaticDataRegistry.getActor(comment.authorId);
      const org = StaticDataRegistry.getOrganization(comment.authorId);

      let userName = comment.userName || comment.authorId;
      let userAvatar = comment.userAvatar;

      if (actor) {
        userName = actor.name;
        userAvatar = actor.profileImageUrl || null;
      } else if (org) {
        userName = org.name;
        userAvatar = org.imageUrl || null;
      }

      previews.push({
        id: comment.id,
        content: comment.content || "",
        createdAt: toISOStringSafe(comment.createdAt),
        userId: comment.authorId,
        userName,
        userUsername: comment.userUsername,
        userAvatar,
        likeCount: comment.likeCount,
      });
    }

    if (previews.length > 0) {
      commentPreviewMap.set(postId, previews);
    }
  }

  // Format posts - simple transformation, no async queries needed!
  const formattedPosts = validPosts.map((post) => {
    const user = userMap.get(post.authorId!);
    const actor = actorMap.get(post.authorId!);
    const org = orgMap.get(post.authorId!);

    let authorName = post.authorId!;
    let authorUsername: string | null = null;
    let authorProfileImageUrl: string | null = null;

    if (actor) {
      authorName = actor.name;
      authorProfileImageUrl = actor.profileImageUrl!;
    } else if (org) {
      authorName = org.name;
      authorProfileImageUrl = org.imageUrl!;
    } else if (user) {
      authorName = user.displayName!;
      authorUsername = user.username!;
      authorProfileImageUrl = user.profileImageUrl;
    }

    const timestamp = toISOStringSafe(post.timestamp);
    const createdAt = toISOStringSafe(post.createdAt);

    // Build base post object
    const basePost = {
      id: post.id,
      type: post.type || undefined,
      content: post.content!,
      fullContent: post.fullContent || undefined,
      articleTitle: post.articleTitle || undefined,
      byline: post.byline || undefined,
      biasScore: post.biasScore !== undefined ? post.biasScore : undefined,
      sentiment: post.sentiment || undefined,
      slant: post.slant || undefined,
      category: post.category || undefined,
      author: post.authorId,
      authorId: post.authorId,
      authorName,
      authorUsername,
      authorProfileImageUrl,
      timestamp,
      createdAt,
      gameId: post.gameId || undefined,
      dayNumber: post.dayNumber || undefined,
      likeCount: reactionMap.get(post.id) ?? 0,
      commentCount: commentMap.get(post.id) ?? 0,
      shareCount: shareMap.get(post.id) ?? 0,
      isLiked: false,
      isShared: false,
      // Comment previews for inline display on feed
      commentPreviews: commentPreviewMap.get(post.id) ?? undefined,
    };

    // Check if this is a repost/quote by presence of originalPostId
    if (post.originalPostId) {
      const isQuote = post.content && post.content.length > 0;
      const originalPost = post.originalPost;

      // If original post exists and is not deleted
      if (originalPost && !originalPost.deletedAt) {
        // Get original post author info
        const originalUser = userMap.get(originalPost.authorId);
        const originalActor = actorMap.get(originalPost.authorId);
        const originalOrg = orgMap.get(originalPost.authorId);

        let originalAuthorName = originalPost.authorId;
        let originalAuthorUsername: string | null = null;
        let originalAuthorProfileImageUrl: string | null = null;

        if (originalActor) {
          originalAuthorName = originalActor.name;
          originalAuthorProfileImageUrl = originalActor.profileImageUrl!;
        } else if (originalOrg) {
          originalAuthorName = originalOrg.name;
          originalAuthorProfileImageUrl = originalOrg.imageUrl!;
        } else if (originalUser) {
          originalAuthorName = originalUser.displayName!;
          originalAuthorUsername = originalUser.username!;
          originalAuthorProfileImageUrl = originalUser.profileImageUrl;
        }

        // For simple reposts (not quotes), use the original post's interaction counts and previews
        // For quote posts, keep the quote post's interaction counts and previews
        const interactionCounts = !isQuote
          ? {
              likeCount: reactionMap.get(originalPost.id) ?? 0,
              commentCount: commentMap.get(originalPost.id) ?? 0,
              shareCount: shareMap.get(originalPost.id) ?? 0,
              // Use original post's comment previews for simple reposts
              commentPreviews:
                commentPreviewMap.get(originalPost.id) ?? undefined,
            }
          : {
              likeCount: basePost.likeCount,
              commentCount: basePost.commentCount,
              shareCount: basePost.shareCount,
            };

        return {
          ...basePost,
          ...interactionCounts,
          isRepost: true,
          isQuote,
          quoteComment: isQuote ? post.content : null,
          originalPostId: originalPost.id,
          originalPost: {
            id: originalPost.id,
            content: originalPost.content,
            authorId: originalPost.authorId,
            authorName: originalAuthorName,
            authorUsername: originalAuthorUsername,
            authorProfileImageUrl: originalAuthorProfileImageUrl,
            timestamp: toISOStringSafe(originalPost.timestamp),
          },
        };
      }

      // If original post is deleted but this is a quote post, return with null originalPost
      if (isQuote) {
        return {
          ...basePost,
          isRepost: true,
          isQuote: true,
          quoteComment: post.content,
          originalPostId: post.originalPostId,
          originalPost: null,
        };
      }
    }

    return basePost;
  });

  // NOTE: Author diversity is NOT applied at the API layer because it would break
  // cursor-based pagination. Post-query reordering cannot be reconciled with
  // timestamp-based cursors without causing duplicates across pages.
  // Feed diversity is instead handled at generation time via:
  // - Stratified action deck (quote/reply ratio with no-consecutive constraint)
  // - Timestamp staggering (posts spread across 5-minute windows)
  // - Action diversity tracker (prevents consecutive same action types)

  logger.info(
    "Formatted posts",
    {
      originalCount: postsResult.length,
      formattedCount: formattedPosts.length,
      filteredOut: postsResult.length - formattedPosts.length,
    },
    "GET /api/posts",
  );

  // Calculate next cursor (timestamp of last post for keyset pagination)
  const nextCursor =
    formattedPosts.length > 0
      ? formattedPosts[formattedPosts.length - 1]?.timestamp
      : null;

  const response = NextResponse.json({
    success: true,
    posts: formattedPosts,
    limit,
    cursor: nextCursor,
    hasMore: formattedPosts.length === limit,
  });

  if (rateLimitInfo) {
    addPublicReadHeaders(response, rateLimitInfo);
  } else {
    response.headers.set(
      "Cache-Control",
      "s-maxage=10, stale-while-revalidate=60, must-revalidate",
    );
  }

  return response;
});

/**
 * POST /api/posts
 *
 * Creates a new post with content validation, rate limiting, and mention notifications.
 * Automatically extracts @mentions, sends notifications, broadcasts via SSE, and invalidates caches.
 *
 * @param request - Next.js request containing post content in JSON body
 * @returns Created post object with author details and metadata
 * @throws {400} Invalid content (empty, too long, duplicate, rate limited)
 * @throws {401} Unauthorized - authentication required
 * @throws {500} Internal server error
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);

  const body = (await request.json()) as { content: string };
  const normalizedContent = body.content.trim();

  const fallbackDisplayName = authUser.walletAddress
    ? `${authUser.walletAddress.slice(0, 6)}...${authUser.walletAddress.slice(-4)}`
    : "Anonymous";

  const { user: canonicalUser } = await ensureUserForAuth(authUser, {
    displayName: fallbackDisplayName,
  });
  const canonicalUserId = canonicalUser.id;
  const rateLimitResponse = checkRateLimitAndDuplicates(
    canonicalUserId,
    normalizedContent,
    RATE_LIMIT_CONFIGS.CREATE_POST,
    DUPLICATE_DETECTION_CONFIGS.POST,
  );
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const clientIpHash = getHashedClientIp(request.headers);
  if (clientIpHash) {
    const ipRateLimit = await checkRateLimitAsync(
      `post-ip:${clientIpHash}`,
      RATE_LIMIT_CONFIGS.CREATE_POST,
    );
    if (!ipRateLimit.allowed) {
      return rateLimitError(ipRateLimit.retryAfter);
    }
  }

  const postId = await generateSnowflakeId();
  const [post] = await db
    .insert(posts)
    .values({
      id: postId,
      content: normalizedContent,
      authorId: canonicalUserId,
      timestamp: new Date(),
    })
    .returning();

  if (!post) {
    logger.error("Failed to create post", { postId }, "POST /api/posts");
    return NextResponse.json(
      {
        success: false,
        error: "Failed to create post",
      },
      { status: 500 },
    );
  }

  const authorName = canonicalUser.username!;

  await cachedDb.invalidatePostsCache();
  await cachedDb.invalidateActorPostsCache(canonicalUserId);
  logger.info(
    "Invalidated post caches",
    { postId: post.id },
    "POST /api/posts",
  );

  broadcastToChannel("feed", {
    type: "new_post",
    post: {
      id: post.id,
      content: post.content,
      authorId: post.authorId,
      authorName: authorName,
      authorUsername: canonicalUser.username,
      authorDisplayName: canonicalUser.displayName,
      authorProfileImageUrl: canonicalUser.profileImageUrl,
      timestamp: toISO(post.timestamp),
    },
  });

  // Invalidate the narrative feed cache so the new post appears in story scoring
  // immediately rather than waiting for the 120s TTL to expire.
  invalidateCache("feed:narrative:v1", { namespace: "feed" }).catch((err) => {
    logger.warn(
      "Narrative feed cache invalidation failed after new post",
      { error: err, postId: post.id },
      "POST /api/posts",
    );
  });
  logger.info(
    "Broadcast new user post to feed channel",
    { postId: post.id },
    "POST /api/posts",
  );

  const mentions = normalizedContent.match(/@(\w+)/g) || [];
  const usernames = [...new Set(mentions.map((m: string) => m.substring(1)))];

  const mentionedUsers =
    usernames.length > 0
      ? await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(inArray(users.username, usernames as string[]))
      : [];

  await Promise.all(
    mentionedUsers.map((mentionedUser) =>
      notifyMention(mentionedUser.id, canonicalUserId, post.id, undefined),
    ),
  );

  logger.info(
    "Sent mention notifications",
    {
      postId: post.id,
      mentionCount: mentionedUsers.length,
      mentionedUsernames: mentionedUsers.map((u) => u.username!),
    },
    "POST /api/posts",
  );

  // Handle player influence for mentioned NPCs (boosts their response probability)
  // Check if any mentioned users are NPCs/actors
  const mentionedActorIds = mentionedUsers
    .filter((u) => {
      // Check if this user is an actor (NPC)
      const actor = StaticDataRegistry.getActor(u.id);
      return actor !== null;
    })
    .map((u) => u.id);

  if (mentionedActorIds.length > 0) {
    // Use Promise.allSettled to handle each mention independently
    // This ensures one failure doesn't prevent processing others
    void Promise.allSettled(
      mentionedActorIds.map((actorId) =>
        handlePlayerMention(canonicalUserId, actorId, post.id),
      ),
    ).then((results) => {
      // Log failures from settled results
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          const actorId = mentionedActorIds[index];
          logger.warn(
            "Failed to handle player mention for NPC",
            {
              actorId,
              postId: post.id,
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            },
            "POST /api/posts",
          );
        }
      });
      // Log summary after all handlePlayerMention calls have settled
      logger.info(
        "Triggered NPC mention influence",
        { postId: post.id, npcCount: mentionedActorIds.length },
        "POST /api/posts",
      );
    });
  }

  trackServerEvent(canonicalUserId, "post_created", {
    postId: post.id,
    contentLength: normalizedContent.length,
    hasUsername: Boolean(canonicalUser.username),
  });

  // Generate and store tags asynchronously (don't block response)
  // This allows posts to be tagged for trending without slowing down the API
  void generateTagsFromPost(normalizedContent)
    .then((generatedTags: GeneratedTag[]) => {
      if (generatedTags.length > 0) {
        return storeTagsForPost(post.id, generatedTags).then(() => {
          logger.info(
            "Tagged user post",
            { postId: post.id, tagCount: generatedTags.length },
            "POST /api/posts",
          );
        });
      }
      return Promise.resolve();
    })
    .catch((tagError: Error) => {
      logger.warn(
        "Failed to tag post",
        { postId: post.id, error: tagError },
        "POST /api/posts",
      );
    });

  void checkProgress(authUser.userId, { type: "post_created" });

  return successResponse({
    success: true,
    post: {
      id: post.id,
      content: post.content,
      authorId: post.authorId,
      authorName: authorName,
      authorUsername: canonicalUser.username,
      authorDisplayName: canonicalUser.displayName,
      authorProfileImageUrl: canonicalUser.profileImageUrl,
      timestamp: toISO(post.timestamp),
      createdAt: toISO(post.createdAt),
    },
  });
});
