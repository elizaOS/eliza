/**
 * CREATE_COMMENT Action
 *
 * Creates a comment on a post or replies to an existing comment.
 * Use CHECK_POST_DETAIL or CHECK_COMMENT_DETAIL first to get IDs.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { and, comments, db, eq, isNull, posts } from "@feed/db";
import { logger } from "../../../../shared/logger";
import { generateSnowflakeId } from "../../../../shared/snowflake";
import { defineActionParameters } from "../../../shared/action-parameters";

export const createCommentAction: Action = {
  name: "CREATE_COMMENT",
  description: "Create a comment on a post or reply to an existing comment.",

  parameters: defineActionParameters({
    postId: {
      type: "string",
      description: "The ID of the post to comment on (required)",
      required: true,
    },
    parentCommentId: {
      type: "string",
      description:
        "The ID of the comment to reply to (optional - omit to comment directly on the post)",
      required: false,
    },
    content: {
      type: "string",
      description: "The content of your comment (required)",
      required: true,
    },
  }),

  examples: [
    [
      {
        name: "user",
        content: { text: 'Comment on post 123 saying "Great point!"' },
      },
      {
        name: "assistant",
        content: { text: "I'll add that comment to the post..." },
      },
    ],
    [
      {
        name: "user",
        content: { text: "Reply to comment 456 disagreeing with their take" },
      },
      {
        name: "assistant",
        content: { text: "I'll reply to that comment..." },
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
      | {
          postId?: string;
          parentCommentId?: string;
          content?: string;
        }
      | undefined;

    const postId = actionParams?.postId;
    const parentCommentId = actionParams?.parentCommentId;
    const content = actionParams?.content;

    // Validate required parameters
    if (!postId) {
      return {
        success: false,
        text: "Missing postId parameter. Use CHECK_POST_DETAIL first to get the post ID.",
        error: "Missing postId",
      };
    }

    if (!content || content.trim().length === 0) {
      return {
        success: false,
        text: "Missing or empty content parameter. Please provide the comment text.",
        error: "Missing content",
      };
    }

    try {
      // Verify the post exists and is not deleted
      const [post] = await db
        .select({ id: posts.id, authorId: posts.authorId })
        .from(posts)
        .where(and(eq(posts.id, postId), isNull(posts.deletedAt)))
        .limit(1);

      if (!post) {
        return {
          success: false,
          text: `Post not found or deleted. Use CHECK_POST_DETAIL to verify the post ID.`,
          error: "Post not found",
        };
      }

      // If replying to a comment, verify it exists
      if (parentCommentId) {
        const [parentComment] = await db
          .select({ id: comments.id, postId: comments.postId })
          .from(comments)
          .where(
            and(eq(comments.id, parentCommentId), isNull(comments.deletedAt)),
          )
          .limit(1);

        if (!parentComment) {
          return {
            success: false,
            text: `Parent comment not found or deleted. Use CHECK_POST_DETAIL to see available comments.`,
            error: "Parent comment not found",
          };
        }

        // Verify the comment belongs to the same post
        if (parentComment.postId !== postId) {
          return {
            success: false,
            text: `Parent comment does not belong to the specified post.`,
            error: "Comment/post mismatch",
          };
        }
      }

      // Create the comment
      const commentId = await generateSnowflakeId();
      const now = new Date();

      await db.insert(comments).values({
        id: commentId,
        content: content.trim(),
        postId,
        authorId: agentUserId,
        parentCommentId: parentCommentId || null,
        createdAt: now,
        updatedAt: now,
      });

      const isReply = !!parentCommentId;
      const actionDescription = isReply
        ? `Replied to comment ${parentCommentId}`
        : `Commented on post ${postId}`;

      logger.info(
        `[CREATE_COMMENT] ${actionDescription}`,
        { commentId, postId, parentCommentId },
        "CreateComment",
      );

      return {
        success: true,
        text: isReply
          ? `Reply created successfully (ID: ${commentId}).`
          : `Comment created successfully (ID: ${commentId}).`,
        data: {
          commentId,
          postId,
          parentCommentId: parentCommentId || null,
          content: content.trim(),
          isReply,
        },
        values: {
          commentId,
          postId,
          parentCommentId: parentCommentId || null,
          isReply,
          contentPreview:
            content.length > 50 ? `${content.substring(0, 50)}...` : content,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("[CREATE_COMMENT] Error:", errorMsg);

      return {
        success: false,
        text: `Failed to create comment: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
