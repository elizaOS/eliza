/**
 * Post Reply API
 *
 * @route POST /api/posts/[id]/reply - Reply to a post
 * @access Authenticated
 *
 * @description
 * Creates a reply/comment to a post with comprehensive quality checks, rate limiting,
 * and game mechanics integration. Includes following mechanics, group chat invites,
 * and quality scoring. Designed for NPC interaction and engagement.
 *
 * @openapi
 * /api/posts/{id}/reply:
 *   post:
 *     tags:
 *       - Posts
 *     summary: Reply to a post
 *     description: Creates a reply comment with quality checks, rate limiting, and game mechanics (following, invites)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Post ID to reply to
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
 *                 description: Reply content
 *               marketId:
 *                 type: string
 *                 description: Optional market ID for tracking
 *               sentiment:
 *                 type: string
 *                 description: Optional sentiment (positive/negative/neutral)
 *     responses:
 *       201:
 *         description: Reply created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 comment:
 *                   type: object
 *                 quality:
 *                   type: object
 *                   properties:
 *                     score:
 *                       type: number
 *                     warnings:
 *                       type: array
 *                 streak:
 *                   type: object
 *                 following:
 *                   type: object
 *                   properties:
 *                     followed:
 *                       type: boolean
 *                 groupChat:
 *                   type: object
 *                   properties:
 *                     invited:
 *                       type: boolean
 *       400:
 *         description: Quality check failed or rate limit exceeded
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Post not found
 *
 * @example
 * ```typescript
 * const response = await fetch(`/api/posts/${postId}/reply`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     content: 'Great post!',
 *     sentiment: 'positive'
 *   })
 * });
 * const { comment, quality, following } = await response.json();
 * ```
 *
 * @see {@link /lib/services/message-quality-checker} Quality checker
 * @see {@link /lib/services/following-mechanics} Following mechanics
 */

import {
  authenticate,
  BusinessLogicError,
  checkProgress,
  ensureUserForAuth,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { comments, db, eq, posts, users } from '@feed/db';
import {
  FollowingMechanics,
  GroupChatService,
  MessageQualityChecker,
  parsePostId,
  ReplyRateLimiter,
} from '@feed/engine';
import {
  generateSnowflakeId,
  logger,
  PostIdParamSchema,
  ReplyToPostSchema,
} from '@feed/shared';
import type { NextRequest } from 'next/server';
import { ensureEngineServices } from '@/lib/engine/ensure-engine-services';
import { POST as createCommentPOST } from '../comments/route';

/**
 * POST /api/posts/[id]/reply
 * Reply to a post with comprehensive checks
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    // Wire engine services for notifications
    ensureEngineServices();

    // 1. Authenticate user
    const user = await authenticate(request);
    const { id: postId } = PostIdParamSchema.parse(await context.params);

    // 3. Extract NPC/author ID from post ID
    const parseResult = parsePostId(postId);

    // Fall back to the generic comments endpoint for standard post IDs.
    // `/reply` is used as a compatibility endpoint by some clients, while the
    // canonical app flow uses `/comments` for normal posts.
    if (!parseResult.success) {
      return createCommentPOST(request, context);
    }

    // 2. Parse and validate request body
    const body = await request.json();
    const { content, marketId, sentiment } = ReplyToPostSchema.parse(body);

    const { gameId, authorId: npcId, timestamp } = parseResult.metadata;

    const displayName = user.walletAddress
      ? `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}`
      : 'Anonymous';

    const { user: dbUser } = await ensureUserForAuth(user, { displayName });
    const canonicalUserId = dbUser.id;

    // 4. Check rate limiting
    const rateLimitResult = await ReplyRateLimiter.canReply(
      canonicalUserId,
      npcId
    );

    if (!rateLimitResult.allowed) {
      throw new BusinessLogicError(
        rateLimitResult.reason || 'Rate limit exceeded',
        'RATE_LIMIT_EXCEEDED'
      );
    }

    // 5. Check message quality
    const qualityResult = await MessageQualityChecker.checkQuality(
      content,
      canonicalUserId,
      'reply',
      postId
    );

    if (!qualityResult.passed) {
      throw new BusinessLogicError(
        qualityResult.errors.join('; '),
        'QUALITY_CHECK_FAILED'
      );
    }

    // 6. Ensure post exists (check first, then upsert)
    const [existingPost] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    if (!existingPost) {
      await db.insert(posts).values({
        id: postId,
        content: '[Game-generated post]',
        authorId: npcId,
        gameId,
        timestamp,
      });
    }

    // 7. Create comment
    const now = new Date();
    const commentId = await generateSnowflakeId();

    const [newComment] = await db
      .insert(comments)
      .values({
        id: commentId,
        content: content.trim(),
        postId,
        authorId: canonicalUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!newComment) {
      throw new BusinessLogicError('Failed to create comment', 'CREATE_FAILED');
    }

    // Get user info for the response
    const [commentAuthor] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        username: users.username,
        profileImageUrl: users.profileImageUrl,
      })
      .from(users)
      .where(eq(users.id, canonicalUserId))
      .limit(1);

    // 8. Record the interaction
    await ReplyRateLimiter.recordReply(
      canonicalUserId,
      npcId,
      postId,
      newComment.id,
      qualityResult.score
    );

    // 9. Check for following chance
    const followingChance = await FollowingMechanics.calculateFollowingChance(
      canonicalUserId,
      npcId,
      rateLimitResult.replyStreak || 0,
      qualityResult.score
    );

    let followed = false;
    if (followingChance.willFollow) {
      await FollowingMechanics.recordFollow(
        canonicalUserId,
        npcId,
        `Streak: ${rateLimitResult.replyStreak}, Quality: ${qualityResult.score.toFixed(2)}`
      );
      followed = true;
    }

    // 10. Check for group chat invite chance (only if followed)
    let invitedToChat = false;
    let chatInfo = null;

    if (
      followed ||
      (await FollowingMechanics.isFollowing(canonicalUserId, npcId))
    ) {
      const inviteChance = await GroupChatService.calculateInviteChance(
        canonicalUserId,
        npcId
      );

      if (
        inviteChance.willInvite &&
        inviteChance.chatId &&
        inviteChance.chatName
      ) {
        await GroupChatService.recordInvite(
          canonicalUserId,
          npcId,
          inviteChance.chatId,
          inviteChance.chatName
        );
        invitedToChat = true;
        chatInfo = {
          chatId: inviteChance.chatId,
          chatName: inviteChance.chatName,
          isOwned: inviteChance.isOwned,
        };
      }
    }

    // 11. Return success with all the feedback
    logger.info(
      'Reply created successfully',
      {
        postId,
        userId: canonicalUserId,
        commentId: newComment.id,
        followed,
        invitedToChat,
        marketId, // Optional: for analytics/tracking
        sentiment, // Optional: for analytics/tracking
      },
      'POST /api/posts/[id]/reply'
    );

    void checkProgress(user.userId, { type: 'comment_created' });

    return successResponse(
      {
        comment: {
          id: newComment.id,
          content: newComment.content,
          postId: newComment.postId,
          authorId: newComment.authorId,
          createdAt: newComment.createdAt,
          author: commentAuthor,
        },
        quality: {
          score: qualityResult.score,
          warnings: qualityResult.warnings,
          factors: qualityResult.factors,
        },
        streak: {
          current: rateLimitResult.replyStreak || 0,
          reason: rateLimitResult.reason,
        },
        following: {
          followed,
          probability: followingChance.probability,
          reasons: followingChance.reasons,
        },
        groupChat: {
          invited: invitedToChat,
          ...(chatInfo || {}),
        },
      },
      201
    );
  }
);
