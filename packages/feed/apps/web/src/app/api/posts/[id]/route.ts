/**
 * API Route: /api/posts/[id]
 * Methods: GET (get single post details), DELETE (soft delete post)
 *
 * @openapi
 * /api/posts/{id}:
 *   get:
 *     tags:
 *       - Posts
 *     summary: Get single post
 *     description: Returns a single post by ID with full details including author, interactions, and repost metadata.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Post ID
 *     responses:
 *       200:
 *         description: Post details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 content:
 *                   type: string
 *                 authorId:
 *                   type: string
 *                 likeCount:
 *                   type: integer
 *                 commentCount:
 *                   type: integer
 *                 shareCount:
 *                   type: integer
 *       404:
 *         description: Post not found
 *   delete:
 *     tags:
 *       - Posts
 *     summary: Delete post
 *     description: Soft deletes a post (author only). Post is marked as deleted but data is retained.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Post ID
 *     responses:
 *       200:
 *         description: Post deleted successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not the post author
 *       404:
 *         description: Post not found
 */

import type { JsonValue } from "@feed/api";
import {
  addPublicReadHeaders,
  authenticate,
  BusinessLogicError,
  NotFoundError,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import {
  and,
  comments,
  count,
  db,
  eq,
  isNull,
  lte,
  posts,
  reactions,
  shares,
  users,
} from "@feed/db";
import { gameService, StaticDataRegistry } from "@feed/engine";
import { logger, PostIdParamSchema, toISO } from "@feed/shared";
import type { NextRequest } from "next/server";
import { POST as likePost } from "./like/route";

/**
 * GET /api/posts/[id]
 * Get a single post by ID
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    const { error, user, rateLimitInfo } = await publicRateLimit(request);
    if (error) return error;
    const withHeaders = (res: ReturnType<typeof successResponse>) => {
      if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
      return res;
    };

    const { id: postId } = PostIdParamSchema.parse(await context.params);

    const now = new Date();

    // Get post from database
    const [post] = await db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.id, postId),
          lte(posts.timestamp, now), // No future posts
        ),
      )
      .limit(1);

    // Get counts and user interactions
    const userId = user?.userId;

    // Check if post exists and is not in the future
    if (post && post.timestamp > now) {
      throw new NotFoundError("Post", postId);
    }

    // If not in database, try to find it in game store/realtime feed first
    if (!post) {
      // Try realtime posts first (most recent)
      const realtimeResult = await gameService.getRealtimePosts(1000, 0);
      const realtimePost = realtimeResult?.posts.find((p) => p.id === postId);

      let gamePost = realtimePost;

      // If not found in realtime, try database posts (synced posts)
      if (!gamePost) {
        const dbPosts = await gameService.getRecentPosts(1000, 0);
        const foundPost = dbPosts.find((p) => p.id === postId);
        if (foundPost) {
          gamePost = {
            ...foundPost,
            author: foundPost.authorId,
            timestamp:
              foundPost.timestamp instanceof Date
                ? toISO(foundPost.timestamp)
                : foundPost.timestamp,
            createdAt:
              foundPost.createdAt instanceof Date
                ? toISO(foundPost.createdAt)
                : foundPost.createdAt,
          } as typeof realtimePost;
        }
      }

      // Check if gamePost is in the future before returning
      if (gamePost) {
        const gamePostTimestamp = new Date(gamePost.timestamp);
        if (gamePostTimestamp > now) {
          throw new NotFoundError("Post", postId);
        }
      }

      // If found in game store, return it directly
      if (gamePost) {
        // Get public data (counts and author info)
        const [[likeCountResult], [commentCountResult], [shareCountResult]] =
          await Promise.all([
            db
              .select({ count: count() })
              .from(reactions)
              .where(
                and(eq(reactions.postId, postId), eq(reactions.type, "like")),
              ),
            db
              .select({ count: count() })
              .from(comments)
              .where(eq(comments.postId, postId)),
            db
              .select({ count: count() })
              .from(shares)
              .where(eq(shares.postId, postId)),
          ]);

        const likeCount = Number(likeCountResult?.count ?? 0);
        const commentCount = Number(commentCountResult?.count ?? 0);
        const shareCount = Number(shareCountResult?.count ?? 0);

        const actor = StaticDataRegistry.getActor(gamePost.authorId);

        const [userRecord] = actor
          ? []
          : await db
              .select({
                displayName: users.displayName,
                username: users.username,
              })
              .from(users)
              .where(eq(users.id, gamePost.authorId))
              .limit(1);

        let authorName = gamePost.authorId;
        let authorUsername: string | null = null;

        if (actor) {
          authorName = actor.name;
        } else if (userRecord) {
          authorName =
            userRecord.displayName || userRecord.username || gamePost.authorId;
          authorUsername = userRecord.username;
        }

        // Get user-specific interaction state (requires authentication)
        let isLiked = false;
        let isShared = false;

        if (userId) {
          const [[likedResult], [sharedResult]] = await Promise.all([
            db
              .select({ id: reactions.id })
              .from(reactions)
              .where(
                and(
                  eq(reactions.postId, postId),
                  eq(reactions.userId, userId),
                  eq(reactions.type, "like"),
                ),
              )
              .limit(1),
            db
              .select({ id: shares.id })
              .from(shares)
              .where(and(eq(shares.postId, postId), eq(shares.userId, userId)))
              .limit(1),
          ]);
          isLiked = !!likedResult;
          isShared = !!sharedResult;
        }

        const timestampStr = gamePost.timestamp as string;
        const createdAtStr = (gamePost.createdAt || timestampStr) as string;

        // Check for repost metadata from originalPostId field (no legacy text parsing)
        let repostMetadata = {};

        const originalPostIdFromGame =
          "originalPostId" in gamePost
            ? ((gamePost as Record<string, JsonValue>).originalPostId as
                | string
                | undefined)
            : undefined;
        if (originalPostIdFromGame) {
          const [originalPost] = await db
            .select({ authorId: posts.authorId, content: posts.content })
            .from(posts)
            .where(eq(posts.id, originalPostIdFromGame))
            .limit(1);

          if (originalPost) {
            // Fetch author details
            const [originalUser] = await db
              .select({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                profileImageUrl: users.profileImageUrl,
              })
              .from(users)
              .where(eq(users.id, originalPost.authorId))
              .limit(1);

            const originalActor = !originalUser
              ? StaticDataRegistry.getActor(originalPost.authorId)
              : null;

            const originalOrg =
              !originalUser && !originalActor
                ? StaticDataRegistry.getOrganization(originalPost.authorId)
                : null;

            const originalAuthor = originalUser || originalActor || originalOrg;

            if (originalAuthor) {
              const isQuote = gamePost.content && gamePost.content.length > 0;
              const authorName =
                originalUser?.displayName ??
                originalActor?.name ??
                originalOrg?.name ??
                originalPost.authorId;
              const authorUsername =
                originalUser?.username ??
                originalActor?.username ??
                originalOrg?.id ??
                originalPost.authorId;
              const authorProfileImageUrl =
                originalUser?.profileImageUrl ??
                originalActor?.profileImageUrl ??
                originalOrg?.imageUrl ??
                null;
              repostMetadata = {
                isRepost: true,
                isQuote,
                quoteComment: isQuote ? gamePost.content : null,
                originalPostId: originalPostIdFromGame,
                originalPost: {
                  id: originalPostIdFromGame,
                  content: originalPost.content,
                  authorId: originalPost.authorId,
                  authorName,
                  authorUsername,
                  authorProfileImageUrl,
                  timestamp: new Date().toISOString(),
                },
              };
            }
          }
        }

        return withHeaders(
          successResponse({
            data: {
              id: gamePost.id,
              type: "post",
              content: gamePost.content,
              fullContent: null,
              articleTitle: null,
              byline: null,
              biasScore: null,
              sentiment: null,
              slant: null,
              category: null,
              imageUrl: null,
              authorId: gamePost.authorId,
              authorName,
              authorUsername,
              authorAvatar: undefined,
              isActorPost: true,
              timestamp: timestampStr,
              createdAt: createdAtStr,
              likeCount,
              commentCount,
              shareCount,
              isLiked,
              isShared,
              source: "game-store",
              ...repostMetadata, // Add repost metadata if applicable
            },
          }),
        );
      }

      let authorId = "system";
      let gameId = "feed";
      let timestamp = new Date();

      const isoTimestampMatch = postId.match(
        /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/,
      );

      if (isoTimestampMatch?.[1]) {
        const timestampStr = isoTimestampMatch[1];
        timestamp = new Date(timestampStr);
        const firstHyphenIndex = postId.indexOf("-");
        if (firstHyphenIndex !== -1) {
          gameId = postId.substring(0, firstHyphenIndex);
          const withoutGameId = postId.substring(firstHyphenIndex + 1);
          const secondHyphenIndex = withoutGameId.indexOf("-");
          if (secondHyphenIndex !== -1) {
            const afterGameTimestamp = withoutGameId.substring(
              secondHyphenIndex + 1,
            );
            authorId = afterGameTimestamp.substring(
              0,
              afterGameTimestamp.lastIndexOf(`-${timestampStr}`),
            );
          }
        }
      } else if (postId.startsWith("post-")) {
        const parts = postId.split("-");
        if (parts.length >= 3 && parts[1]) {
          const timestampNum = Number.parseInt(parts[1], 10);
          if (!Number.isNaN(timestampNum) && timestampNum > 1000000000000) {
            timestamp = new Date(timestampNum);
            if (parts.length >= 4 && parts[2] && !parts[2].includes(".")) {
              const potentialActorId = parts[2];
              const actorRecord = StaticDataRegistry.getActor(potentialActorId);
              if (actorRecord) {
                authorId = potentialActorId;
              }
            }
          }
        }
      }

      // Check if post already exists
      const [existingPost] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, postId))
        .limit(1);

      let createdPost;
      if (!existingPost) {
        // Create the post
        const [newPost] = await db
          .insert(posts)
          .values({
            id: postId,
            content: "[Game-generated post]",
            authorId,
            gameId,
            timestamp,
          })
          .returning();
        createdPost = newPost;
      } else {
        createdPost = existingPost;
      }

      if (!createdPost) {
        throw new BusinessLogicError("Post not found", "POST_NOT_FOUND");
      }

      // Get counts for the created/existing post
      const [[likeCountResult], [commentCountResult], [shareCountResult]] =
        await Promise.all([
          db
            .select({ count: count() })
            .from(reactions)
            .where(
              and(eq(reactions.postId, postId), eq(reactions.type, "like")),
            ),
          db
            .select({ count: count() })
            .from(comments)
            .where(eq(comments.postId, postId)),
          db
            .select({ count: count() })
            .from(shares)
            .where(eq(shares.postId, postId)),
        ]);

      const likeCount = Number(likeCountResult?.count ?? 0);
      const commentCount = Number(commentCountResult?.count ?? 0);
      const shareCount = Number(shareCountResult?.count ?? 0);

      // Get user interactions
      let isLiked = false;
      let isShared = false;

      if (userId) {
        const [[likedResult], [sharedResult]] = await Promise.all([
          db
            .select({ id: reactions.id })
            .from(reactions)
            .where(
              and(
                eq(reactions.postId, postId),
                eq(reactions.userId, userId),
                eq(reactions.type, "like"),
              ),
            )
            .limit(1),
          db
            .select({ id: shares.id })
            .from(shares)
            .where(and(eq(shares.postId, postId), eq(shares.userId, userId)))
            .limit(1),
        ]);
        isLiked = !!likedResult;
        isShared = !!sharedResult;
      }

      let authorName = createdPost.authorId;
      let authorUsername: string | null = null;
      let authorProfileImageUrl: string | null = null;

      const actorRecord = StaticDataRegistry.getActor(createdPost.authorId);

      if (actorRecord) {
        authorName = actorRecord.name;
        authorProfileImageUrl =
          actorRecord.profileImageUrl || `/images/actors/${actorRecord.id}.jpg`;
      } else {
        const [userRecord] = await db
          .select({
            displayName: users.displayName,
            username: users.username,
            profileImageUrl: users.profileImageUrl,
          })
          .from(users)
          .where(eq(users.id, createdPost.authorId))
          .limit(1);

        if (userRecord) {
          authorName =
            userRecord.displayName ||
            userRecord.username ||
            createdPost.authorId;
          authorUsername = userRecord.username || null;
          authorProfileImageUrl = userRecord.profileImageUrl || null;
        }
      }

      return withHeaders(
        successResponse({
          data: {
            id: createdPost.id,
            type: createdPost.type || "post",
            content: createdPost.content,
            fullContent: createdPost.fullContent || null,
            articleTitle: createdPost.articleTitle || null,
            byline: createdPost.byline || null,
            biasScore:
              createdPost.biasScore !== undefined
                ? createdPost.biasScore
                : null,
            sentiment: createdPost.sentiment || null,
            slant: createdPost.slant || null,
            category: createdPost.category || null,
            imageUrl: createdPost.imageUrl || null,
            authorId: createdPost.authorId,
            authorName,
            authorUsername,
            authorProfileImageUrl,
            authorAvatar: authorProfileImageUrl || undefined,
            isActorPost: true,
            timestamp: createdPost.timestamp
              ? toISO(createdPost.timestamp)
              : toISO(createdPost.createdAt),
            createdAt: toISO(createdPost.createdAt),
            likeCount,
            commentCount,
            shareCount,
            isLiked,
            isShared,
            source: "database",
          },
        }),
      );
    }

    if (!post) {
      throw new BusinessLogicError("Post not found", "POST_NOT_FOUND");
    }

    // Check if post is deleted
    if (post.deletedAt) {
      throw new BusinessLogicError(
        "This post has been deleted",
        "POST_DELETED",
      );
    }

    // Get counts
    const [[likeCountResult], [commentCountResult], [shareCountResult]] =
      await Promise.all([
        db
          .select({ count: count() })
          .from(reactions)
          .where(and(eq(reactions.postId, postId), eq(reactions.type, "like"))),
        db
          .select({ count: count() })
          .from(comments)
          .where(eq(comments.postId, postId)),
        db
          .select({ count: count() })
          .from(shares)
          .where(eq(shares.postId, postId)),
      ]);

    const likeCount = Number(likeCountResult?.count ?? 0);
    const commentCount = Number(commentCountResult?.count ?? 0);
    const shareCount = Number(shareCountResult?.count ?? 0);

    // Get user interactions
    let isLiked = false;
    let isShared = false;

    if (userId) {
      const [[likedResult], [sharedResult]] = await Promise.all([
        db
          .select({ id: reactions.id })
          .from(reactions)
          .where(
            and(
              eq(reactions.postId, postId),
              eq(reactions.userId, userId),
              eq(reactions.type, "like"),
            ),
          )
          .limit(1),
        db
          .select({ id: shares.id })
          .from(shares)
          .where(and(eq(shares.postId, postId), eq(shares.userId, userId)))
          .limit(1),
      ]);
      isLiked = !!likedResult;
      isShared = !!sharedResult;
    }

    let authorName = post.authorId;
    let authorUsername: string | null = null;
    let authorProfileImageUrl: string | null = null;

    const actor = StaticDataRegistry.getActor(post.authorId);

    if (actor) {
      authorName = actor.name;
      // Use database profileImageUrl or construct path from actor ID
      authorProfileImageUrl =
        actor.profileImageUrl || `/images/actors/${actor.id}.jpg`;
    } else {
      // Check if it's an organization (for articles)
      const org = StaticDataRegistry.getOrganization(post.authorId);

      if (org) {
        authorName = org.name;
        // Use database imageUrl or construct path from organization ID
        authorProfileImageUrl =
          org.imageUrl || `/images/organizations/${org.id}.jpg`;
      } else {
        const [usr] = await db
          .select({
            displayName: users.displayName,
            username: users.username,
            profileImageUrl: users.profileImageUrl,
          })
          .from(users)
          .where(eq(users.id, post.authorId))
          .limit(1);

        if (usr) {
          authorName = usr.displayName || usr.username || post.authorId;
          authorUsername = usr.username || null;
          authorProfileImageUrl = usr.profileImageUrl || null;
        }
      }
    }

    // Build repost metadata from originalPostId (clean, no regex parsing)
    let repostMetadata = {};

    if (post.originalPostId) {
      const [originalPost] = await db
        .select()
        .from(posts)
        .where(and(eq(posts.id, post.originalPostId), isNull(posts.deletedAt)))
        .limit(1);

      if (originalPost) {
        const isQuote = post.content && post.content.length > 0;

        // Get original post author
        const [originalUser] = await db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            profileImageUrl: users.profileImageUrl,
          })
          .from(users)
          .where(eq(users.id, originalPost.authorId))
          .limit(1);

        const originalActor = !originalUser
          ? StaticDataRegistry.getActor(originalPost.authorId)
          : null;

        const originalOrg =
          !originalUser && !originalActor
            ? StaticDataRegistry.getOrganization(originalPost.authorId)
            : null;

        const originalAuthor = originalUser || originalActor || originalOrg;

        if (originalAuthor) {
          const authorName =
            originalUser?.displayName ??
            originalActor?.name ??
            originalOrg?.name ??
            originalPost.authorId;
          const authorUsername =
            originalUser?.username ??
            originalActor?.username ??
            originalOrg?.id ??
            originalPost.authorId;
          const authorProfileImageUrl =
            originalUser?.profileImageUrl ??
            originalActor?.profileImageUrl ??
            originalOrg?.imageUrl ??
            null;
          repostMetadata = {
            isRepost: true,
            isQuote,
            quoteComment: isQuote ? post.content : null,
            originalPostId: originalPost.id,
            originalPost: {
              id: originalPost.id,
              content: originalPost.content,
              authorId: originalPost.authorId,
              authorName,
              authorUsername,
              authorProfileImageUrl,
              timestamp:
                originalPost.timestamp?.toISOString?.() ||
                new Date().toISOString(),
            },
          };
        }
      }
    }

    logger.info(
      "Post fetched successfully",
      { postId, source: "database" },
      "GET /api/posts/[id]",
    );

    return withHeaders(
      successResponse({
        data: {
          id: post.id,
          type: post.type || "post",
          content: post.content,
          fullContent: post.fullContent || null,
          articleTitle: post.articleTitle || null,
          byline: post.byline || null,
          biasScore: post.biasScore !== undefined ? post.biasScore : null,
          sentiment: post.sentiment || null,
          slant: post.slant || null,
          category: post.category || null,
          imageUrl: post.imageUrl || null,
          authorId: post.authorId,
          authorName: authorName,
          authorUsername: authorUsername,
          authorProfileImageUrl: authorProfileImageUrl,
          authorAvatar: authorProfileImageUrl || undefined,
          isActorPost: true, // Posts are from game actors
          timestamp: post.timestamp
            ? toISO(post.timestamp)
            : toISO(post.createdAt),
          createdAt: toISO(post.createdAt),
          likeCount,
          commentCount,
          shareCount,
          isLiked,
          isShared,
          source: "database",
          ...repostMetadata, // Add repost metadata if applicable
        },
      }),
    );
  },
);

// Backwards-compatible alias for clients that POST to the post resource to like it.
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    return likePost(request, context);
  },
);

/**
 * DELETE /api/posts/[id]
 * Soft delete a post (mark as deleted)
 */
export const DELETE = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    const { id: postId } = PostIdParamSchema.parse(await context.params);

    // Require authentication (throws error if not authenticated)
    const user = await authenticate(request);

    // Get the post to check ownership
    const [post] = await db
      .select({
        id: posts.id,
        authorId: posts.authorId,
        deletedAt: posts.deletedAt,
      })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    if (!post) {
      throw new BusinessLogicError("Post not found", "POST_NOT_FOUND");
    }

    // Check if post is already deleted
    if (post.deletedAt) {
      throw new BusinessLogicError(
        "Post already deleted",
        "POST_ALREADY_DELETED",
      );
    }

    // Check if user is the author of the post
    if (post.authorId !== user.userId) {
      throw new BusinessLogicError(
        "Unauthorized to delete this post",
        "UNAUTHORIZED",
      );
    }

    // Soft delete the post by setting deletedAt timestamp
    await db
      .update(posts)
      .set({ deletedAt: new Date() })
      .where(eq(posts.id, postId));

    logger.info(
      "Post soft deleted",
      { postId, userId: user.userId },
      "DELETE /api/posts/[id]",
    );

    return successResponse({
      message: "Post deleted successfully",
      data: { id: postId, deletedAt: new Date().toISOString() },
    });
  },
);
