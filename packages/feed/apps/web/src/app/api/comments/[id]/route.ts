/**
 * Comment Management API
 *
 * @description
 * Edit or delete individual comments. Only comment authors can modify
 * their own comments. Includes cascade deletion of replies and reactions.
 *
 * **Features:**
 * - Author-only editing
 * - Author-only deletion
 * - Cascade delete (removes replies and reactions)
 * - Content validation
 * - RLS enforcement
 *
 * @openapi
 * /api/comments/{id}:
 *   patch:
 *     tags:
 *       - Comments
 *     summary: Edit comment
 *     description: Updates comment content (author only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Comment ID
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
 *                 description: Updated comment content
 *     responses:
 *       200:
 *         description: Comment updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 content:
 *                   type: string
 *                 author:
 *                   type: object
 *                 likeCount:
 *                   type: integer
 *                 replyCount:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not the comment author
 *       404:
 *         description: Comment not found
 *   delete:
 *     tags:
 *       - Comments
 *     summary: Delete comment
 *     description: Deletes comment and all replies (author only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Comment ID
 *     responses:
 *       200:
 *         description: Comment deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 deletedCommentId:
 *                   type: string
 *                 deletedRepliesCount:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not the comment author
 *       404:
 *         description: Comment not found
 *
 * @example
 * ```typescript
 * // Edit comment
 * await fetch(`/api/comments/${commentId}`, {
 *   method: 'PATCH',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     content: 'Updated comment text'
 *   })
 * });
 *
 * // Delete comment
 * const response = await fetch(`/api/comments/${commentId}`, {
 *   method: 'DELETE',
 *   headers: { 'Authorization': `Bearer ${token}` }
 * });
 * const { deletedRepliesCount } = await response.json();
 * console.log(`Deleted comment and ${deletedRepliesCount} replies`);
 * ```
 *
 * @see {@link /lib/db/context} RLS context
 */

import {
  AuthorizationError,
  authenticate,
  getCanonicalUserId,
  NotFoundError,
  optionalAuth,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  and,
  asc,
  comments,
  count,
  db,
  eq,
  inArray,
  posts,
  reactions,
  shares,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { IdParamSchema, logger, UpdateCommentSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';

// Max reply count to return (for efficiency)
import { MAX_REPLY_COUNT } from '@/lib/constants';

// Max parent chain depth to prevent infinite loops
const MAX_PARENT_DEPTH = 50;

/**
 * Get full parent chain for a comment (oldest first)
 * Returns array of parent comments from root to immediate parent
 */
async function getParentChain(commentId: string | null): Promise<
  {
    id: string;
    content: string;
    authorId: string;
    createdAt: Date;
    parentCommentId: string | null;
  }[]
> {
  const parents: {
    id: string;
    content: string;
    authorId: string;
    createdAt: Date;
    parentCommentId: string | null;
  }[] = [];

  let currentParentId = commentId;
  let depth = 0;

  while (currentParentId && depth < MAX_PARENT_DEPTH) {
    const [parent] = await db
      .select({
        id: comments.id,
        content: comments.content,
        authorId: comments.authorId,
        createdAt: comments.createdAt,
        parentCommentId: comments.parentCommentId,
      })
      .from(comments)
      .where(eq(comments.id, currentParentId))
      .limit(1);

    if (!parent) break;

    parents.unshift(parent); // Add to beginning (oldest first)
    currentParentId = parent.parentCommentId;
    depth++;
  }

  return parents;
}

/**
 * Count all replies under comments using iterative batch approach
 * More efficient than recursive - uses BFS with batched queries
 * Caps at MAX_REPLY_COUNT for performance
 */
async function countAllRepliesBatch(
  commentIds: string[]
): Promise<Map<string, number>> {
  const countMap = new Map<string, number>();

  // Initialize counts to 0
  for (const id of commentIds) {
    countMap.set(id, 0);
  }

  // For each comment, do BFS to count all nested replies
  for (const rootId of commentIds) {
    let count = 0;
    let currentLevel = [rootId];

    // BFS through reply tree, but stop at MAX_REPLY_COUNT
    while (currentLevel.length > 0 && count < MAX_REPLY_COUNT) {
      // Get all direct replies to current level comments
      const replies = await db
        .select({ id: comments.id })
        .from(comments)
        .where(inArray(comments.parentCommentId, currentLevel));

      count += replies.length;

      // Cap at max
      if (count >= MAX_REPLY_COUNT) {
        count = MAX_REPLY_COUNT;
        break;
      }

      // Move to next level
      currentLevel = replies.map((r) => r.id);
    }

    countMap.set(rootId, count);
  }

  return countMap;
}

/**
 * GET /api/comments/[id]
 * Get a single comment with its direct replies
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { id: commentId } = IdParamSchema.parse(await context.params);

    // Optional authentication (to show liked status for logged-in users)
    const user = await optionalAuth(request);
    const canonicalUserId = user ? getCanonicalUserId(user) : undefined;

    // Find the comment
    const [comment] = await db
      .select()
      .from(comments)
      .where(eq(comments.id, commentId))
      .limit(1);

    if (!comment) {
      throw new NotFoundError('Comment', commentId);
    }

    // Get the post info with author
    const [post] = await db
      .select({
        id: posts.id,
        content: posts.content,
        authorId: posts.authorId,
        createdAt: posts.createdAt,
      })
      .from(posts)
      .where(eq(posts.id, comment.postId))
      .limit(1);

    // Get post author info - check StaticDataRegistry first (for actors/orgs), then database
    let postAuthorName = post?.authorId || 'Unknown';
    let postAuthorUsername: string | null = null;
    let postAuthorProfileImageUrl: string | null = null;

    if (post) {
      // Check if it's an actor (NPC/agent)
      const actor = StaticDataRegistry.getActor(post.authorId);
      if (actor) {
        postAuthorName = actor.name;
        postAuthorProfileImageUrl =
          actor.profileImageUrl || `/images/actors/${actor.id}.jpg`;
      } else {
        // Check if it's an organization
        const org = StaticDataRegistry.getOrganization(post.authorId);
        if (org) {
          postAuthorName = org.name;
          postAuthorProfileImageUrl =
            org.imageUrl || `/images/organizations/${org.id}.jpg`;
        } else {
          // Fall back to database user lookup
          const [userRecord] = await db
            .select({
              displayName: users.displayName,
              username: users.username,
              profileImageUrl: users.profileImageUrl,
            })
            .from(users)
            .where(eq(users.id, post.authorId))
            .limit(1);

          if (userRecord) {
            postAuthorName =
              userRecord.displayName || userRecord.username || post.authorId;
            postAuthorUsername = userRecord.username || null;
            postAuthorProfileImageUrl = userRecord.profileImageUrl || null;
          }
        }
      }
    }

    // Get post interaction counts (parallel queries)
    let postLikeCount = 0;
    let postCommentCount = 0;
    let postShareCount = 0;
    let postIsLiked = false;
    let postIsShared = false;

    if (post) {
      const [[likeCountResult], [commentCountResult], [shareCountResult]] =
        await Promise.all([
          db
            .select({ count: count() })
            .from(reactions)
            .where(
              and(eq(reactions.postId, post.id), eq(reactions.type, 'like'))
            ),
          db
            .select({ count: count() })
            .from(comments)
            .where(eq(comments.postId, post.id)),
          db
            .select({ count: count() })
            .from(shares)
            .where(eq(shares.postId, post.id)),
        ]);

      postLikeCount = Number(likeCountResult?.count ?? 0);
      postCommentCount = Number(commentCountResult?.count ?? 0);
      postShareCount = Number(shareCountResult?.count ?? 0);

      if (canonicalUserId) {
        const [[likedResult], [sharedResult]] = await Promise.all([
          db
            .select({ id: reactions.id })
            .from(reactions)
            .where(
              and(
                eq(reactions.postId, post.id),
                eq(reactions.userId, canonicalUserId),
                eq(reactions.type, 'like')
              )
            )
            .limit(1),
          db
            .select({ id: shares.id })
            .from(shares)
            .where(
              and(
                eq(shares.postId, post.id),
                eq(shares.userId, canonicalUserId)
              )
            )
            .limit(1),
        ]);
        postIsLiked = !!likedResult;
        postIsShared = !!sharedResult;
      }
    }

    // Get comment author info
    const [commentAuthor] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        username: users.username,
        profileImageUrl: users.profileImageUrl,
      })
      .from(users)
      .where(eq(users.id, comment.authorId))
      .limit(1);

    // Get direct replies to this comment
    const directReplies = await db
      .select()
      .from(comments)
      .where(eq(comments.parentCommentId, commentId))
      .orderBy(asc(comments.createdAt));

    // Get author IDs for replies
    const replyAuthorIds = [...new Set(directReplies.map((r) => r.authorId))];

    // Get user info for reply authors
    const replyAuthors =
      replyAuthorIds.length > 0
        ? await db
            .select({
              id: users.id,
              displayName: users.displayName,
              username: users.username,
              profileImageUrl: users.profileImageUrl,
            })
            .from(users)
            .where(inArray(users.id, replyAuthorIds))
        : [];

    const authorMap = new Map(replyAuthors.map((a) => [a.id, a]));

    // Get like counts and reply counts for all comments (main + replies)
    const allCommentIds = [commentId, ...directReplies.map((r) => r.id)];

    const likeCounts = await db
      .select({
        commentId: reactions.commentId,
        count: count(),
      })
      .from(reactions)
      .where(
        and(
          inArray(reactions.commentId, allCommentIds),
          eq(reactions.type, 'like')
        )
      )
      .groupBy(reactions.commentId);

    const likeCountMap = new Map(
      likeCounts.map((l) => [l.commentId, Number(l.count)])
    );

    // Get user's likes if authenticated
    let userLikes: Set<string> = new Set();
    if (canonicalUserId) {
      const likes = await db
        .select({ commentId: reactions.commentId })
        .from(reactions)
        .where(
          and(
            inArray(reactions.commentId, allCommentIds),
            eq(reactions.userId, canonicalUserId),
            eq(reactions.type, 'like')
          )
        );
      userLikes = new Set(
        likes.map((l) => l.commentId).filter((id): id is string => id !== null)
      );
    }

    // Get full parent chain (oldest to newest, excluding current comment)
    const parentChainRaw = comment.parentCommentId
      ? await getParentChain(comment.parentCommentId)
      : [];

    // Get author info for all parents
    const parentAuthorIds = [...new Set(parentChainRaw.map((p) => p.authorId))];
    const parentAuthors =
      parentAuthorIds.length > 0
        ? await db
            .select({
              id: users.id,
              displayName: users.displayName,
              username: users.username,
              profileImageUrl: users.profileImageUrl,
            })
            .from(users)
            .where(inArray(users.id, parentAuthorIds))
        : [];
    const parentAuthorMap = new Map(parentAuthors.map((a) => [a.id, a]));

    // Format parent chain
    const parentChain = parentChainRaw.map((parent) => {
      const author = parentAuthorMap.get(parent.authorId);
      return {
        id: parent.id,
        content: parent.content,
        authorId: parent.authorId,
        authorName: author?.displayName || 'Unknown',
        authorUsername: author?.username || null,
        authorProfileImageUrl: author?.profileImageUrl || null,
        createdAt: parent.createdAt,
      };
    });

    // Get immediate parent for "Replying to" indicator
    const parentComment =
      parentChain.length > 0 ? parentChain[parentChain.length - 1] : null;

    // Get total reply counts for main comment and all direct replies (batched)
    const allIdsToCount = [commentId, ...directReplies.map((r) => r.id)];
    const replyCountMap = await countAllRepliesBatch(allIdsToCount);

    // Format main comment
    const formattedComment = {
      id: comment.id,
      content: comment.content,
      postId: comment.postId,
      authorId: comment.authorId,
      authorName: commentAuthor?.displayName || 'Unknown',
      authorUsername: commentAuthor?.username || null,
      authorProfileImageUrl: commentAuthor?.profileImageUrl || null,
      parentCommentId: comment.parentCommentId,
      parentComment,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      likeCount: likeCountMap.get(commentId) || 0,
      replyCount: replyCountMap.get(commentId) || 0,
      isLiked: userLikes.has(commentId),
    };

    // Format replies
    const formattedReplies = directReplies.map((reply) => {
      const author = authorMap.get(reply.authorId);
      return {
        id: reply.id,
        content: reply.content,
        postId: reply.postId,
        authorId: reply.authorId,
        authorName: author?.displayName || 'Unknown',
        authorUsername: author?.username || null,
        authorProfileImageUrl: author?.profileImageUrl || null,
        parentCommentId: reply.parentCommentId,
        parentCommentAuthorName: commentAuthor?.displayName || 'Unknown',
        createdAt: reply.createdAt,
        updatedAt: reply.updatedAt,
        likeCount: likeCountMap.get(reply.id) || 0,
        replyCount: replyCountMap.get(reply.id) || 0,
        isLiked: userLikes.has(reply.id),
      };
    });

    return successResponse({
      comment: formattedComment,
      replies: formattedReplies,
      parentChain, // Full parent chain from root to immediate parent
      post: post
        ? {
            id: post.id,
            content: post.content,
            authorId: post.authorId,
            authorName: postAuthorName,
            authorUsername: postAuthorUsername,
            authorProfileImageUrl: postAuthorProfileImageUrl,
            createdAt: post.createdAt,
            likeCount: postLikeCount,
            commentCount: postCommentCount,
            shareCount: postShareCount,
            isLiked: postIsLiked,
            isShared: postIsShared,
          }
        : null,
    });
  }
);

/**
 * PATCH /api/comments/[id]
 * Edit a comment (only by the author)
 */
export const PATCH = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    // Authenticate user
    const user = await authenticate(request);
    const { id: commentId } = IdParamSchema.parse(await context.params);

    // Parse and validate request body
    const body = await request.json();
    const { content } = UpdateCommentSchema.parse(body);

    // Find comment
    const [comment] = await db
      .select()
      .from(comments)
      .where(eq(comments.id, commentId))
      .limit(1);

    if (!comment) {
      throw new NotFoundError('Comment', commentId);
    }

    // Check if user is the author
    if (comment.authorId !== user.userId) {
      throw new AuthorizationError(
        'You can only edit your own comments',
        'comment',
        'edit'
      );
    }

    // Update comment
    const now = new Date();
    const [updatedComment] = await db
      .update(comments)
      .set({
        content: content.trim(),
        updatedAt: now,
      })
      .where(eq(comments.id, commentId))
      .returning();

    if (!updatedComment) {
      throw new NotFoundError('Comment', commentId);
    }

    // Get user info
    const [commentUser] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        username: users.username,
        profileImageUrl: users.profileImageUrl,
      })
      .from(users)
      .where(eq(users.id, updatedComment.authorId))
      .limit(1);

    // Get counts
    const [[likeCountResult], [replyCountResult]] = await Promise.all([
      db
        .select({ count: count() })
        .from(reactions)
        .where(
          and(eq(reactions.commentId, commentId), eq(reactions.type, 'like'))
        ),
      db
        .select({ count: count() })
        .from(comments)
        .where(eq(comments.parentCommentId, commentId)),
    ]);

    const likeCount = Number(likeCountResult?.count ?? 0);
    const replyCount = Number(replyCountResult?.count ?? 0);

    logger.info(
      'Comment updated successfully',
      { commentId, userId: user.userId },
      'PATCH /api/comments/[id]'
    );

    return successResponse({
      id: updatedComment.id,
      content: updatedComment.content,
      postId: updatedComment.postId,
      authorId: updatedComment.authorId,
      parentCommentId: updatedComment.parentCommentId,
      createdAt: updatedComment.createdAt,
      updatedAt: updatedComment.updatedAt,
      author: commentUser,
      likeCount,
      replyCount,
    });
  }
);

/**
 * DELETE /api/comments/[id]
 * Delete a comment (only by the author)
 */
export const DELETE = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    // Authenticate user
    const user = await authenticate(request);
    const { id: commentId } = IdParamSchema.parse(await context.params);

    // Find comment
    const [comment] = await db
      .select()
      .from(comments)
      .where(eq(comments.id, commentId))
      .limit(1);

    if (!comment) {
      throw new NotFoundError('Comment', commentId);
    }

    // Check if user is the author
    if (comment.authorId !== user.userId) {
      throw new AuthorizationError(
        'You can only delete your own comments',
        'comment',
        'delete'
      );
    }

    // Get reply count before deletion
    const [replyCountResult] = await db
      .select({ count: count() })
      .from(comments)
      .where(eq(comments.parentCommentId, commentId));
    const repliesCount = Number(replyCountResult?.count ?? 0);

    // Delete reactions on replies first
    const replies = await db
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.parentCommentId, commentId));

    const replyIds = replies.map((r) => r.id);

    if (replyIds.length > 0) {
      // Delete reactions on replies
      for (const replyId of replyIds) {
        await db.delete(reactions).where(eq(reactions.commentId, replyId));
      }
    }

    // Delete replies
    await db.delete(comments).where(eq(comments.parentCommentId, commentId));

    // Delete reactions on the main comment
    await db.delete(reactions).where(eq(reactions.commentId, commentId));

    // Delete the main comment
    await db.delete(comments).where(eq(comments.id, commentId));

    logger.info(
      'Comment deleted successfully',
      { commentId, userId: user.userId, deletedRepliesCount: repliesCount },
      'DELETE /api/comments/[id]'
    );

    return successResponse({
      message: 'Comment deleted successfully',
      deletedCommentId: commentId,
      deletedRepliesCount: repliesCount,
    });
  }
);
