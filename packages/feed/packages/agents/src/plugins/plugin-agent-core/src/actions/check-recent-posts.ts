/**
 * Check Recent Posts Action
 *
 * Returns recent posts for a user (self or another user by ID).
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { db, desc, eq, posts, users } from "@feed/db";
import { getTimeAgo } from "@feed/shared";
import { logger } from "../../../../shared/logger";

export const checkRecentPostsAction: Action = {
  name: "CHECK_RECENT_POSTS",
  description:
    "Check recent posts for yourself or another user. Use LOOKUP_USER first to get a userId by username.",

  parameters: {
    userId: {
      type: "string",
      description:
        "User ID to check posts for. Use LOOKUP_USER to find ID by username. Omit to check your own posts.",
      required: false,
    },
    limit: {
      type: "number",
      description: "Number of posts to retrieve (default: 5, max: 20)",
      required: false,
    },
  } as unknown as Action["parameters"],

  examples: [
    [
      {
        name: "user",
        content: { text: "What have you posted recently?" },
      },
      {
        name: "assistant",
        content: { text: "Let me check my recent posts..." },
      },
    ],
    [
      {
        name: "user",
        content: { text: "Show me ThunderGrid's posts" },
      },
      {
        name: "assistant",
        content: { text: "I'll look up ThunderGrid and check their posts..." },
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
    const limit = Math.min(Math.max(actionParams?.limit ?? 5, 1), 20);

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

      const recentPosts = await db
        .select({
          id: posts.id,
          content: posts.content,
          createdAt: posts.createdAt,
        })
        .from(posts)
        .where(eq(posts.authorId, targetUserId))
        .orderBy(desc(posts.createdAt))
        .limit(limit);

      if (recentPosts.length === 0) {
        return {
          success: true,
          text: isSelf ? "No posts yet." : `${targetName} has no posts.`,
          data: { posts: [], count: 0, userId: targetUserId },
          values: { count: 0 },
        };
      }

      // Format posts for display
      const formattedPosts = recentPosts.map((post, i) => ({
        index: i + 1,
        content: post.content,
        timeAgo: getTimeAgo(post.createdAt),
        id: post.id,
      }));

      logger.info(
        `[CHECK_RECENT_POSTS] Retrieved ${recentPosts.length} posts for ${isSelf ? "self" : targetUserId}`,
        undefined,
        "CheckRecentPosts",
      );

      return {
        success: true,
        text: `Retrieved ${recentPosts.length} posts${isSelf ? "" : ` from ${targetName}`}.`,
        data: {
          posts: formattedPosts,
          count: recentPosts.length,
          userId: targetUserId,
          userName: targetName,
        },
        values: {
          count: recentPosts.length,
          userId: targetUserId,
          userName: targetName,
          posts: formattedPosts.map((p) => ({
            id: p.id,
            content: p.content.substring(0, 100),
            timeAgo: p.timeAgo,
          })),
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("[CHECK_RECENT_POSTS] Error:", errorMsg);

      return {
        success: false,
        text: `Failed to retrieve posts: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
