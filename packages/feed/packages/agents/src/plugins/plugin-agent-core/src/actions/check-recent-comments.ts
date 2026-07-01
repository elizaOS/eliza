/**
 * Check Recent Comments Action
 *
 * Returns recent comments for a user (self or another user by ID) with thread context.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { comments, db, desc, eq, inArray, posts, users } from "@feed/db";
import { getTimeAgo } from "@feed/shared";
import { logger } from "../../../../shared/logger";
import { defineActionParameters } from "../../../shared/action-parameters";

interface ThreadMessage {
  authorName: string;
  content: string;
  isTarget: boolean;
}

interface CommentWithThread {
  id: string;
  content: string;
  timeAgo: string;
  post: {
    id: string;
    content: string;
    authorName: string;
  };
  thread: ThreadMessage[];
  isReply: boolean;
}

/**
 * Build thread by walking UP from a comment to its ancestors
 */
async function buildThread(
  commentId: string,
  targetUserId: string,
  maxDepth = 5,
): Promise<ThreadMessage[]> {
  const thread: ThreadMessage[] = [];
  let currentId: string | null = commentId;
  let depth = 0;

  while (currentId && depth < maxDepth) {
    const [comment] = await db
      .select({
        id: comments.id,
        content: comments.content,
        authorId: comments.authorId,
        parentCommentId: comments.parentCommentId,
        authorName: users.displayName,
        authorUsername: users.username,
      })
      .from(comments)
      .leftJoin(users, eq(comments.authorId, users.id))
      .where(eq(comments.id, currentId))
      .limit(1);

    if (!comment) break;

    const isTarget = comment.authorId === targetUserId;
    thread.unshift({
      authorName: comment.authorName || comment.authorUsername || "User",
      content: comment.content,
      isTarget,
    });

    currentId = comment.parentCommentId;
    depth++;
  }

  return thread;
}

export const checkRecentCommentsAction: Action = {
  name: "CHECK_RECENT_COMMENTS",
  description:
    "Check recent comments for yourself or another user with thread context. Use LOOKUP_USER first to get a userId by username.",

  parameters: defineActionParameters({
    userId: {
      type: "string",
      description:
        "User ID to check comments for. Use LOOKUP_USER to find ID by username. Omit to check your own comments.",
      required: false,
    },
    limit: {
      type: "number",
      description: "Number of comments to retrieve (default: 5, max: 10)",
      required: false,
    },
  }),

  examples: [
    [
      {
        name: "user",
        content: { text: "What have you commented on recently?" },
      },
      {
        name: "assistant",
        content: { text: "Let me check my recent comments..." },
      },
    ],
    [
      {
        name: "user",
        content: { text: "Show me ThunderGrid's comments" },
      },
      {
        name: "assistant",
        content: {
          text: "I'll look up ThunderGrid and check their comments...",
        },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => true,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const actionParams = state?.data?.actionParams as
      | { userId?: string; limit?: number }
      | undefined;

    // Use provided userId or default to agent's own ID
    const targetUserId = actionParams?.userId || runtime.agentId;
    const isSelf = targetUserId === runtime.agentId;
    const limit = Math.min(Math.max(actionParams?.limit ?? 5, 1), 10);

    try {
      // Get user info if checking someone else
      let targetName = "You";
      if (!isSelf) {
        const [targetUser] = await db
          .select({
            displayName: users.displayName,
            username: users.username,
          })
          .from(users)
          .where(eq(users.id, targetUserId))
          .limit(1);

        if (!targetUser) {
          return {
            success: false,
            text: `User not found. Call LOOKUP_USER first to get valid userId.`,
            error: "User not found",
          };
        }
        targetName = targetUser.displayName || targetUser.username || "User";
      }

      // Get recent comments
      const recentComments = await db
        .select({
          id: comments.id,
          content: comments.content,
          createdAt: comments.createdAt,
          postId: comments.postId,
          parentCommentId: comments.parentCommentId,
        })
        .from(comments)
        .where(eq(comments.authorId, targetUserId))
        .orderBy(desc(comments.createdAt))
        .limit(limit);

      if (recentComments.length === 0) {
        return {
          success: true,
          text: isSelf ? "No comments yet." : `${targetName} has no comments.`,
          data: { comments: [], count: 0, userId: targetUserId },
          values: { count: 0 },
        };
      }

      // Get all unique post IDs
      const postIds = [...new Set(recentComments.map((c) => c.postId))];

      // Fetch posts with author info
      const postsData = await db
        .select({
          id: posts.id,
          content: posts.content,
          authorId: posts.authorId,
          authorName: users.displayName,
          authorUsername: users.username,
        })
        .from(posts)
        .leftJoin(users, eq(posts.authorId, users.id))
        .where(inArray(posts.id, postIds));

      const postMap = new Map(postsData.map((p) => [p.id, p]));

      // Build full comment data with threads
      const formattedComments: CommentWithThread[] = [];

      for (const comment of recentComments) {
        const post = postMap.get(comment.postId);
        const isReply = !!comment.parentCommentId;

        // Build thread context if it's a reply
        const thread = isReply
          ? await buildThread(comment.id, targetUserId)
          : [
              {
                authorName: targetName,
                content: comment.content,
                isTarget: true,
              },
            ];

        formattedComments.push({
          id: comment.id,
          content: comment.content,
          timeAgo: getTimeAgo(comment.createdAt),
          post: {
            id: comment.postId,
            content: post?.content || "[Post unavailable]",
            authorName:
              post?.authorName || post?.authorUsername || "Unknown User",
          },
          thread,
          isReply,
        });
      }

      logger.info(
        `[CHECK_RECENT_COMMENTS] Retrieved ${recentComments.length} comments for ${isSelf ? "self" : targetUserId}`,
        undefined,
        "CheckRecentComments",
      );

      return {
        success: true,
        text: `Retrieved ${recentComments.length} comments${isSelf ? "" : ` from ${targetName}`}.`,
        data: {
          comments: formattedComments,
          count: recentComments.length,
          userId: targetUserId,
          userName: targetName,
        },
        values: {
          count: recentComments.length,
          userId: targetUserId,
          userName: targetName,
          comments: formattedComments.map((c) => ({
            id: c.id,
            postId: c.post.id,
            content: c.content.substring(0, 100),
            timeAgo: c.timeAgo,
            isReply: c.isReply,
            thread: c.thread.map((t) => ({
              author: t.authorName,
              content: t.content.substring(0, 100),
            })),
          })),
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("[CHECK_RECENT_COMMENTS] Error:", errorMsg);

      return {
        success: false,
        text: `Failed to retrieve comments: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
