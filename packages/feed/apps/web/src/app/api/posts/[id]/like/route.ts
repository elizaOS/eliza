/**
 * API Route: /api/posts/[id]/like
 * Methods: POST (like), DELETE (unlike)
 *
 * @openapi
 * /api/posts/{id}/like:
 *   post:
 *     tags:
 *       - Posts
 *     summary: Like a post
 *     description: Adds a like reaction to a post. Creates notification for post author.
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
 *         description: Post liked successfully
 *       400:
 *         description: Already liked or rate limited
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Post not found
 *   delete:
 *     tags:
 *       - Posts
 *     summary: Unlike a post
 *     description: Removes a like reaction from a post.
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
 *         description: Post unliked successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Post or like not found
 */

import {
  authenticate,
  BusinessLogicError,
  CACHE_KEYS,
  checkProgress,
  checkRateLimitAndDuplicates,
  ensureUserForAuth,
  invalidateCache,
  NotFoundError,
  narrativeEnrichmentKey,
  notifyReactionOnPost,
  RATE_LIMIT_CONFIGS,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { and, count, db, eq, posts, reactions } from '@feed/db';
import { NPCInteractionTracker, parsePostId } from '@feed/engine';
import {
  generateSnowflakeId,
  logger,
  PostIdParamSchema,
} from '@feed/shared';
import type { NextRequest } from 'next/server';
import { trackServerEvent } from '@/lib/posthog/server';

/**
 * POST /api/posts/[id]/like
 * Like a post
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    // Authenticate user
    const user = await authenticate(request);
    const { id: postId } = PostIdParamSchema.parse(await context.params);

    // Apply rate limiting (no duplicate detection needed - DB prevents duplicate likes)
    const rateLimitError = checkRateLimitAndDuplicates(
      user.userId,
      null,
      RATE_LIMIT_CONFIGS.LIKE_POST
    );
    if (rateLimitError) {
      return rateLimitError;
    }

    const displayName = user.walletAddress
      ? `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}`
      : 'Anonymous';

    const { user: dbUser } = await ensureUserForAuth(user, { displayName });
    const canonicalUserId = dbUser.id;

    // Check if post exists first and is not in the future
    const now = new Date();
    let [post] = await db
      .select()
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    // Don't allow liking future posts
    if (post && post.timestamp > now) {
      throw new NotFoundError('Post', postId);
    }

    if (!post) {
      const parseResult = parsePostId(postId);
      const { gameId, authorId, timestamp } = parseResult.metadata;

      const [newPost] = await db
        .insert(posts)
        .values({
          id: postId,
          content: '[Game-generated post]',
          authorId,
          gameId,
          timestamp,
        })
        .returning();
      if (!newPost) {
        throw new BusinessLogicError('Failed to create post', 'CREATE_FAILED');
      }
      post = newPost;
    }

    // Ensure post exists
    if (!post) {
      throw new NotFoundError('Post', postId);
    }

    // Check if post is deleted - allow likes to be removed but not added
    if (post.deletedAt) {
      // Allow unlike but not like
      const [existingReaction] = await db
        .select({ id: reactions.id })
        .from(reactions)
        .where(
          and(
            eq(reactions.postId, postId),
            eq(reactions.userId, canonicalUserId),
            eq(reactions.type, 'like')
          )
        )
        .limit(1);

      if (!existingReaction) {
        // Trying to add a new like to deleted post - reject
        throw new BusinessLogicError(
          'Cannot like deleted post',
          'POST_DELETED'
        );
      }
      // If reaction exists, allow the unlike action to proceed
    }

    // Check if already liked
    const [existingLike] = await db
      .select({ id: reactions.id })
      .from(reactions)
      .where(
        and(
          eq(reactions.postId, postId),
          eq(reactions.userId, canonicalUserId),
          eq(reactions.type, 'like')
        )
      )
      .limit(1);

    if (existingLike) {
      throw new BusinessLogicError('Post already liked', 'ALREADY_LIKED');
    }

    // Create like reaction
    await db.insert(reactions).values({
      id: await generateSnowflakeId(),
      postId,
      userId: canonicalUserId,
      type: 'like',
    });

    // Create notification for post author (if not self-like)
    if (
      post.authorId &&
      post.authorId !== canonicalUserId &&
      post.authorId !== 'unknown'
    ) {
      await notifyReactionOnPost(
        post.authorId,
        canonicalUserId,
        postId,
        'like'
      );
    }

    // Track interaction with NPC (if post author is NPC)
    await NPCInteractionTracker.trackLike(canonicalUserId, postId).catch(
      (error) => {
        logger.warn('Failed to track NPC interaction', { error });
      }
    );

    // Get updated like count
    const [likeCountResult] = await db
      .select({ count: count() })
      .from(reactions)
      .where(and(eq(reactions.postId, postId), eq(reactions.type, 'like')));
    const likeCount = Number(likeCountResult?.count ?? 0);

    // Invalidate interaction cache for this post
    await invalidateCache(`post:${postId}:interactions:*`, {
      namespace: CACHE_KEYS.POST,
    });

    // Bust the narrative enrichment cache so isLiked reflects immediately
    // (without this, the user sees isLiked: false for up to 30s in Stories)
    invalidateCache(narrativeEnrichmentKey(canonicalUserId), {
      namespace: 'feed',
    }).catch((err) =>
      logger.warn(
        'Failed to invalidate narrative enrichment cache on like',
        { error: err, userId: canonicalUserId },
        'POST /api/posts/[id]/like'
      )
    );

    logger.info(
      'Post liked successfully',
      { postId, userId: canonicalUserId, likeCount },
      'POST /api/posts/[id]/like'
    );

    // Track post liked event
    trackServerEvent(canonicalUserId, 'post_liked', {
      postId,
      authorId: post.authorId,
      likeCount,
    }).catch((error) => {
      logger.warn('Failed to track post_liked event', { error });
    });

    void checkProgress(canonicalUserId, { type: 'reaction_created' });

    return successResponse({
      data: {
        likeCount,
        isLiked: true,
      },
    });
  }
);

/**
 * DELETE /api/posts/[id]/like
 * Unlike a post
 */
export const DELETE = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    // Authenticate user
    const user = await authenticate(request);
    const { id: postId } = await context.params;

    // Validate post ID
    if (!postId) {
      throw new BusinessLogicError('Post ID is required', 'POST_ID_REQUIRED');
    }

    // Ensure user exists in database (upsert pattern)
    const displayName = user.walletAddress
      ? `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}`
      : 'Anonymous';

    const { user: dbUser } = await ensureUserForAuth(user, { displayName });
    const canonicalUserId = dbUser.id;

    // Find existing like
    const [reaction] = await db
      .select({ id: reactions.id })
      .from(reactions)
      .where(
        and(
          eq(reactions.postId, postId),
          eq(reactions.userId, canonicalUserId),
          eq(reactions.type, 'like')
        )
      )
      .limit(1);

    if (!reaction) {
      throw new NotFoundError('Like', `${postId}-${canonicalUserId}`);
    }

    // Delete like
    await db.delete(reactions).where(eq(reactions.id, reaction.id));

    // Get updated like count
    const [likeCountResult] = await db
      .select({ count: count() })
      .from(reactions)
      .where(and(eq(reactions.postId, postId), eq(reactions.type, 'like')));
    const likeCount = Number(likeCountResult?.count ?? 0);

    // Invalidate interaction cache for this post
    await invalidateCache(`post:${postId}:interactions:*`, {
      namespace: CACHE_KEYS.POST,
    });

    invalidateCache(narrativeEnrichmentKey(canonicalUserId), {
      namespace: 'feed',
    }).catch((err) =>
      logger.warn(
        'Failed to invalidate narrative enrichment cache on unlike',
        { error: err, userId: canonicalUserId },
        'DELETE /api/posts/[id]/like'
      )
    );

    logger.info(
      'Post unliked successfully',
      { postId, userId: canonicalUserId, likeCount },
      'DELETE /api/posts/[id]/like'
    );

    // Track post unliked event
    trackServerEvent(canonicalUserId, 'post_unliked', {
      postId,
      likeCount,
    }).catch((error) => {
      logger.warn('Failed to track post_unliked event', { error });
    });

    return successResponse({
      data: {
        likeCount,
        isLiked: false,
      },
    });
  }
);
