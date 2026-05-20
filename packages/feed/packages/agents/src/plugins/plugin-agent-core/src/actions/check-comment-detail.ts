/**
 * CHECK_COMMENT_DETAIL Action
 *
 * Returns detailed information about a comment including its thread context.
 * Shows the parent chain (walking UP) and direct replies (children).
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { and, comments, db, eq, isNull, posts, users } from "@feed/db";
import { logger } from "../../../../shared/logger";

const MAX_THREAD_DEPTH = 10;

interface CommentWithRelations {
  id: string;
  content: string;
  authorId: string;
  parentCommentId: string | null;
  createdAt: Date;
  authorName: string;
}

interface ThreadMessage {
  id: string;
  author: string;
  content: string;
  depth: number;
  isTarget: boolean;
}

/**
 * Build thread by walking UP from target comment
 */
function buildThreadFromBottom(
  targetId: string,
  commentMap: Map<string, CommentWithRelations>,
  agentUserId: string,
): ThreadMessage[] {
  const target = commentMap.get(targetId);
  if (!target) return [];

  const chain: CommentWithRelations[] = [target];
  let currentId = target.parentCommentId;

  // Walk UP the parent chain
  while (currentId && chain.length < MAX_THREAD_DEPTH) {
    const parent = commentMap.get(currentId);
    if (!parent) break;
    chain.unshift(parent); // prepend = oldest first
    currentId = parent.parentCommentId;
  }

  return chain.map((c, i) => ({
    id: c.id,
    author: c.authorId === agentUserId ? "You" : c.authorName,
    content: c.content,
    depth: i,
    isTarget: c.id === targetId,
  }));
}

export const checkCommentDetailAction: Action = {
  name: "CHECK_COMMENT_DETAIL",
  description:
    "Get detailed information about a comment including its thread context (parent chain and replies).",

  parameters: {
    commentId: {
      type: "string",
      description: "The ID of the comment to retrieve",
      required: true,
    },
  } as unknown as Action["parameters"],

  examples: [
    [
      {
        name: "user",
        content: { text: "Show me comment 789" },
      },
      {
        name: "assistant",
        content: { text: "Let me get the details of that comment..." },
      },
    ],
    [
      {
        name: "user",
        content: { text: "What is the context of that comment?" },
      },
      {
        name: "assistant",
        content: { text: "I'll check the thread context..." },
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
    const agentUserId = runtime.agentId;
    const actionParams = state?.data?.actionParams as
      | { commentId?: string }
      | undefined;
    const commentId = actionParams?.commentId;

    if (!commentId) {
      return {
        success: false,
        text: "Missing commentId parameter. Please provide the comment ID.",
        error: "Missing commentId",
      };
    }

    try {
      // Get the target comment with its post
      const [targetComment] = await db
        .select({
          id: comments.id,
          content: comments.content,
          authorId: comments.authorId,
          parentCommentId: comments.parentCommentId,
          postId: comments.postId,
          createdAt: comments.createdAt,
          authorUsername: users.username,
          authorDisplayName: users.displayName,
        })
        .from(comments)
        .leftJoin(users, eq(comments.authorId, users.id))
        .where(eq(comments.id, commentId))
        .limit(1);

      if (!targetComment) {
        return {
          success: false,
          text: `Comment not found with ID: ${commentId}`,
          error: "Comment not found",
        };
      }

      // Get the post
      const [post] = await db
        .select({
          id: posts.id,
          content: posts.content,
          authorId: posts.authorId,
          authorUsername: users.username,
          authorDisplayName: users.displayName,
        })
        .from(posts)
        .leftJoin(users, eq(posts.authorId, users.id))
        .where(eq(posts.id, targetComment.postId))
        .limit(1);

      if (!post) {
        return {
          success: false,
          text: `Parent post not found for comment ${commentId}`,
          error: "Post not found",
        };
      }

      // Get all comments on this post for building context
      type CommentRow = {
        id: string;
        content: string;
        authorId: string;
        parentCommentId: string | null;
        createdAt: Date;
        authorUsername: string | null;
        authorDisplayName: string | null;
      };

      const allComments: CommentRow[] = await db
        .select({
          id: comments.id,
          content: comments.content,
          authorId: comments.authorId,
          parentCommentId: comments.parentCommentId,
          createdAt: comments.createdAt,
          authorUsername: users.username,
          authorDisplayName: users.displayName,
        })
        .from(comments)
        .leftJoin(users, eq(comments.authorId, users.id))
        .where(
          and(
            eq(comments.postId, targetComment.postId),
            isNull(comments.deletedAt),
          ),
        );

      // Build comment map
      const commentMap = new Map<string, CommentWithRelations>();
      for (const c of allComments) {
        commentMap.set(c.id, {
          id: c.id,
          content: c.content,
          authorId: c.authorId,
          parentCommentId: c.parentCommentId,
          createdAt: c.createdAt,
          authorName: c.authorDisplayName || c.authorUsername || "User",
        });
      }

      // Build thread context (walking UP from target)
      const threadContext = buildThreadFromBottom(
        commentId,
        commentMap,
        agentUserId,
      );

      // Get direct replies to this comment
      const directReplies = allComments
        .filter((c: CommentRow) => c.parentCommentId === commentId)
        .map((c: CommentRow) => ({
          id: c.id,
          author:
            c.authorId === agentUserId
              ? "You"
              : c.authorDisplayName || c.authorUsername || "User",
          content:
            c.content.length > 100
              ? `${c.content.substring(0, 100)}...`
              : c.content,
        }));

      const postAuthorName =
        post.authorId === agentUserId
          ? "You"
          : post.authorDisplayName || post.authorUsername || "User";

      // Build formatted view like AutonomousBatchResponseService
      const threadLines = threadContext.map((msg) => {
        const marker = msg.isTarget ? " [TARGET COMMENT]" : "";
        const depthLabel =
          msg.depth === 0 ? "Comment" : `Reply (depth ${msg.depth})`;
        const truncated =
          msg.content.length > 200
            ? `${msg.content.substring(0, 200)}...`
            : msg.content;
        return `- ${depthLabel} [ID: ${msg.id}] by @${msg.author}: "${truncated}"${marker}`;
      });

      const repliesLines =
        directReplies.length > 0
          ? directReplies.map(
              (r: { id: string; author: string; content: string }) =>
                `  - Reply [ID: ${r.id}] by @${r.author}: "${r.content}"`,
            )
          : [];

      const formattedView = `POST [ID: ${post.id}] by @${postAuthorName}:
"${post.content.substring(0, 300)}${post.content.length > 300 ? "..." : ""}"

THREAD CONTEXT:
${threadLines.join("\n")}
${repliesLines.length > 0 ? `\nDIRECT REPLIES:\n${repliesLines.join("\n")}` : ""}`;

      logger.info(
        `[CHECK_COMMENT_DETAIL] Retrieved comment ${commentId} with ${threadContext.length} ancestors, ${directReplies.length} replies`,
        undefined,
        "CheckCommentDetail",
      );

      return {
        success: true,
        text: `Retrieved comment with ${threadContext.length - 1} parent(s) and ${directReplies.length} replies.`,
        data: {
          post: {
            id: post.id,
            content: post.content,
            author: postAuthorName,
          },
          targetComment: {
            id: targetComment.id,
            content: targetComment.content,
            author:
              targetComment.authorId === agentUserId
                ? "You"
                : targetComment.authorDisplayName ||
                  targetComment.authorUsername ||
                  "User",
          },
          threadContext,
          directReplies,
        },
        values: {
          formattedView,
          postId: post.id,
          commentId: targetComment.id,
          threadDepth: threadContext.length,
          replyCount: directReplies.length,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("[CHECK_COMMENT_DETAIL] Error:", errorMsg);

      return {
        success: false,
        text: `Failed to retrieve comment: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
