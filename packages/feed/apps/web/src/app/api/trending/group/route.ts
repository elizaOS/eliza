/**
 * Grouped Trending API
 *
 * @route GET /api/trending/group - Get posts for multiple trending tags
 * @access Public
 *
 * @description
 * Returns posts for a group of trending tags. Used when displaying grouped
 * trends (e.g., "OpenAGI" + "Sam Altman" as one trending topic).
 *
 * @openapi
 * /api/trending/group:
 *   get:
 *     tags:
 *       - Trending
 *     summary: Get posts for grouped trending tags
 *     description: Returns posts that match any of the provided tag slugs
 *     parameters:
 *       - in: query
 *         name: tags
 *         required: true
 *         schema:
 *           type: string
 *         description: Comma-separated tag slugs (e.g., "openagi,sam-altman")
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of posts to return
 *     responses:
 *       200:
 *         description: Posts retrieved successfully
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
 *                 tags:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       displayName:
 *                         type: string
 *                       category:
 *                         type: string
 *       400:
 *         description: Invalid parameters
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/trending/group?tags=openagi,sam-altman');
 * const { posts, tags } = await response.json();
 * ```
 */

import {
  addPublicReadHeaders,
  publicRateLimit,
  withErrorHandling,
} from "@feed/api";
import {
  and,
  asPublic,
  asUser,
  comments,
  count,
  desc,
  eq,
  inArray,
  isNull,
  posts,
  postTags,
  reactions,
  shares,
  tags,
  users,
} from "@feed/db";
import { StaticDataRegistry } from "@feed/engine";
import { logger, toISO } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const GET = withErrorHandling(async (request: NextRequest) => {
  const {
    error,
    user: authUser,
    rateLimitInfo,
  } = await publicRateLimit(request);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const tagsParam = searchParams.get("tags");
  const limitParam = searchParams.get("limit");

  if (!tagsParam) {
    return NextResponse.json(
      { success: false, error: "Missing required parameter: tags" },
      { status: 400 },
    );
  }

  const tagSlugs = tagsParam
    .split(",")
    .map((slug) => slug.trim().toLowerCase())
    .filter((slug) => slug.length > 0);

  if (tagSlugs.length === 0) {
    return NextResponse.json(
      { success: false, error: "Invalid tags parameter" },
      { status: 400 },
    );
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;

  logger.info(
    "Fetching grouped trending posts",
    { tagSlugs, limit },
    "GET /api/trending/group",
  );

  // Get tag information by slug (name)
  const tagsList = authUser?.userId
    ? await asUser(authUser, async (db) => {
        return await db
          .select({
            id: tags.id,
            name: tags.name,
            displayName: tags.displayName,
            category: tags.category,
          })
          .from(tags)
          .where(inArray(tags.name, tagSlugs));
      })
    : await asPublic(async (db) => {
        return await db
          .select({
            id: tags.id,
            name: tags.name,
            displayName: tags.displayName,
            category: tags.category,
          })
          .from(tags)
          .where(inArray(tags.name, tagSlugs));
      });

  // Extract tag IDs for the post lookup
  const tagIds = tagsList.map((t) => t.id);

  if (tagIds.length === 0) {
    return NextResponse.json({
      success: true,
      posts: [],
      tags: [],
    });
  }

  // Get posts that have any of these tags
  // Filter out deleted posts to match what users can actually see
  const postTagRelations = authUser?.userId
    ? await asUser(authUser, async (db) => {
        return await db
          .select({
            postId: postTags.postId,
            tagId: postTags.tagId,
            createdAt: postTags.createdAt,
            post: {
              id: posts.id,
              content: posts.content,
              authorId: posts.authorId,
              timestamp: posts.timestamp,
              type: posts.type,
              articleTitle: posts.articleTitle,
              byline: posts.byline,
              biasScore: posts.biasScore,
              category: posts.category,
            },
          })
          .from(postTags)
          .innerJoin(posts, eq(postTags.postId, posts.id))
          .where(and(inArray(postTags.tagId, tagIds), isNull(posts.deletedAt)))
          .orderBy(desc(postTags.createdAt))
          .limit(limit * 2); // Get more to deduplicate
      })
    : await asPublic(async (db) => {
        return await db
          .select({
            postId: postTags.postId,
            tagId: postTags.tagId,
            createdAt: postTags.createdAt,
            post: {
              id: posts.id,
              content: posts.content,
              authorId: posts.authorId,
              timestamp: posts.timestamp,
              type: posts.type,
              articleTitle: posts.articleTitle,
              byline: posts.byline,
              biasScore: posts.biasScore,
              category: posts.category,
            },
          })
          .from(postTags)
          .innerJoin(posts, eq(postTags.postId, posts.id))
          .where(and(inArray(postTags.tagId, tagIds), isNull(posts.deletedAt)))
          .orderBy(desc(postTags.createdAt))
          .limit(limit * 2);
      });

  // Deduplicate posts (same post might have multiple tags from the group)
  const seenPostIds = new Set<string>();
  const uniquePosts = postTagRelations
    .filter((pt) => {
      if (seenPostIds.has(pt.postId)) {
        return false;
      }
      seenPostIds.add(pt.postId);
      return true;
    })
    .slice(0, limit);

  // Get interaction counts for posts
  const postIds = uniquePosts.map((pt) => pt.postId);

  // Get user info for authors
  const authorIds = [...new Set(uniquePosts.map((pt) => pt.post.authorId))];
  const usersList = authUser?.userId
    ? await asUser(authUser, async (db) => {
        return await db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
          })
          .from(users)
          .where(inArray(users.id, authorIds));
      })
    : await asPublic(async (db) => {
        return await db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
          })
          .from(users)
          .where(inArray(users.id, authorIds));
      });

  const userMap = new Map(usersList.map((u) => [u.id, u]));
  const actorMap = new Map(
    authorIds
      .map((id) => StaticDataRegistry.getActor(id))
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .map((a) => [a.id, { id: a.id, name: a.name }]),
  );
  const orgMap = new Map(
    authorIds
      .map((id) => StaticDataRegistry.getOrganization(id))
      .filter((o): o is NonNullable<typeof o> => o !== null)
      .map((o) => [o.id, { id: o.id, name: o.name }]),
  );

  // Get interaction counts using Drizzle's count aggregation
  const [likeCounts, commentCounts, shareCounts] =
    postIds.length > 0
      ? authUser?.userId
        ? await asUser(authUser, async (db) => {
            return await Promise.all([
              db
                .select({ postId: reactions.postId, count: count() })
                .from(reactions)
                .where(inArray(reactions.postId, postIds))
                .groupBy(reactions.postId),
              db
                .select({ postId: comments.postId, count: count() })
                .from(comments)
                .where(inArray(comments.postId, postIds))
                .groupBy(comments.postId),
              db
                .select({ postId: shares.postId, count: count() })
                .from(shares)
                .where(inArray(shares.postId, postIds))
                .groupBy(shares.postId),
            ]);
          })
        : await asPublic(async (db) => {
            return await Promise.all([
              db
                .select({ postId: reactions.postId, count: count() })
                .from(reactions)
                .where(inArray(reactions.postId, postIds))
                .groupBy(reactions.postId),
              db
                .select({ postId: comments.postId, count: count() })
                .from(comments)
                .where(inArray(comments.postId, postIds))
                .groupBy(comments.postId),
              db
                .select({ postId: shares.postId, count: count() })
                .from(shares)
                .where(inArray(shares.postId, postIds))
                .groupBy(shares.postId),
            ]);
          })
      : [[], [], []];

  const likeMap = new Map(likeCounts.map((lc) => [lc.postId, lc.count || 0]));
  const commentMap = new Map(
    commentCounts.map((cc) => [cc.postId, cc.count || 0]),
  );
  const shareMap = new Map(shareCounts.map((sc) => [sc.postId, sc.count || 0]));

  // Format posts
  const formattedPosts = uniquePosts.map((pt) => {
    const user = userMap.get(pt.post.authorId);
    const actor = actorMap.get(pt.post.authorId);
    const org = orgMap.get(pt.post.authorId);

    let authorName = pt.post.authorId;
    let authorUsername: string | null = null;

    if (user) {
      authorName = user.displayName || user.username || pt.post.authorId;
      authorUsername = user.username;
    } else if (actor) {
      authorName = actor.name;
    } else if (org) {
      authorName = org.name || pt.post.authorId;
    }

    return {
      id: pt.post.id,
      content: pt.post.content,
      authorId: pt.post.authorId,
      authorName,
      authorUsername,
      timestamp: toISO(pt.post.timestamp),
      likeCount: likeMap.get(pt.post.id) || 0,
      commentCount: commentMap.get(pt.post.id) || 0,
      shareCount: shareMap.get(pt.post.id) || 0,
      type: pt.post.type,
      articleTitle: pt.post.articleTitle,
      byline: pt.post.byline,
      biasScore: pt.post.biasScore,
      category: pt.post.category,
    };
  });

  logger.info(
    "Grouped trending posts retrieved",
    {
      tagCount: tagsList.length,
      postCount: formattedPosts.length,
    },
    "GET /api/trending/group",
  );

  const res = NextResponse.json({
    success: true,
    posts: formattedPosts,
    tags: tagsList,
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
