/**
 * Trending Tag Detail API
 *
 * @route GET /api/trending/[tag] - Get posts by tag
 * @access Public (optional authentication for RLS)
 *
 * @description
 * Returns posts with a specific tag. Supports pagination. Optional authentication
 * applies RLS for personalized results.
 *
 * @openapi
 * /api/trending/{tag}:
 *   get:
 *     tags:
 *       - Trending
 *     summary: Get posts by tag
 *     description: Returns posts with specific tag (optional auth for RLS)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tag
 *         required: true
 *         schema:
 *           type: string
 *         description: Tag name
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Posts per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: Posts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 posts:
 *                   type: array
 *       401:
 *         description: Unauthorized (optional)
 *
 * @example
 * ```typescript
 * const { posts } = await fetch('/api/trending/crypto?limit=20')
 *   .then(r => r.json());
 * ```
 */

import {
  addPublicReadHeaders,
  publicRateLimit,
  withErrorHandling,
} from "@feed/api";
import { asPublic, asUser } from "@feed/db";
import { getPostsByTag, StaticDataRegistry } from "@feed/engine";
import { toISO } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const GET = withErrorHandling(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tag: string }> },
) {
  const {
    error,
    user: authUser,
    rateLimitInfo,
  } = await publicRateLimit(request);
  if (error) return error;

  const { tag } = await params;
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") || "20", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") || "0", 10);

  if (!tag) {
    return NextResponse.json(
      {
        success: false,
        error: "Tag parameter is required",
      },
      { status: 400 },
    );
  }

  const result = await getPostsByTag(tag, { limit, offset });

  if (!result.tag) {
    return NextResponse.json(
      {
        success: false,
        error: "Tag not found",
        posts: [],
        total: 0,
      },
      { status: 404 },
    );
  }

  // Enrich posts with author information and engagement stats with RLS
  const enrichedPosts = await Promise.all(
    result.posts.map(async (post) => {
      // Get author info (could be User, Actor, or Organization)
      const actor = StaticDataRegistry.getActor(post.authorId);
      const org = StaticDataRegistry.getOrganization(post.authorId);

      const [user, likeCount, commentCount, shareCount, userLike, userShare] =
        authUser?.userId
          ? await asUser(authUser, async (db) => {
              return await Promise.all([
                db.user.findUnique({
                  where: { id: post.authorId },
                  select: {
                    id: true,
                    username: true,
                    displayName: true,
                    profileImageUrl: true,
                    isActor: true,
                  },
                }),
                db.reaction.count({
                  where: { postId: post.id, type: "like" },
                }),
                db.comment.count({
                  where: { postId: post.id },
                }),
                db.share.count({
                  where: { postId: post.id },
                }),
                db.reaction.findFirst({
                  where: {
                    postId: post.id,
                    userId: authUser.userId,
                    type: "like",
                  },
                  select: { id: true },
                }),
                db.share.findFirst({
                  where: { postId: post.id, userId: authUser.userId },
                  select: { id: true },
                }),
              ]);
            })
          : await asPublic(async (db) => {
              return await Promise.all([
                db.user.findUnique({
                  where: { id: post.authorId },
                  select: {
                    id: true,
                    username: true,
                    displayName: true,
                    profileImageUrl: true,
                    isActor: true,
                  },
                }),
                db.reaction.count({
                  where: { postId: post.id, type: "like" },
                }),
                db.comment.count({
                  where: { postId: post.id },
                }),
                db.share.count({
                  where: { postId: post.id },
                }),
                null, // No user context for public requests
                null, // No user context for public requests
              ]);
            });

      // Determine author info
      const authorName =
        user?.displayName ||
        user?.username ||
        actor?.name ||
        org?.name ||
        "Unknown";
      const authorUsername = user?.username || null;
      const authorProfileImageUrl =
        user?.profileImageUrl ||
        actor?.profileImageUrl ||
        org?.imageUrl ||
        null;

      return {
        id: post.id,
        content: post.content,
        authorId: post.authorId,
        authorName,
        authorUsername,
        authorProfileImageUrl,
        timestamp: toISO(post.timestamp),
        likeCount,
        commentCount,
        shareCount,
        isLiked: !!userLike,
        isShared: !!userShare,
      };
    }),
  );

  const res = NextResponse.json({
    success: true,
    tag: {
      name: result.tag.name,
      displayName: result.tag.displayName,
      category: result.tag.category,
    },
    posts: enrichedPosts,
    total: result.total,
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
