/**
 * LOOKUP_USER Action
 *
 * Look up a user by username or display name to get their ID for other actions.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { db, ilike, or, users } from "@feed/db";
import { logger } from "../../../../shared/logger";

export const lookupUserAction: Action = {
  name: "LOOKUP_USER",
  description:
    "Look up a user by username or display name to get their ID. Use the returned userId with CHECK_RECENT_POSTS or CHECK_RECENT_COMMENTS.",
  parameters: {
    username: {
      type: "string",
      description:
        'Username or display name to search for (e.g., "ThunderGrid" or "tcm0843")',
      required: true,
    },
  } as unknown as Action["parameters"],
  examples: [
    [
      {
        name: "user",
        content: { text: "Find ThunderGrid's user ID" },
      },
      {
        name: "assistant",
        content: { text: "Looking up that user..." },
      },
    ],
    [
      {
        name: "user",
        content: { text: "Who is tcm0843?" },
      },
      {
        name: "assistant",
        content: { text: "I'll look up that username." },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => true,

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const actionParams = state?.data?.actionParams as
      | { username?: string }
      | undefined;
    const searchTerm = actionParams?.username?.trim();

    if (!searchTerm) {
      return {
        success: false,
        text: "Missing username parameter.",
        error: "Missing username",
      };
    }

    try {
      // Search by username or display name (case-insensitive)
      const foundUsers = await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          isAgent: users.isAgent,
          profileImageUrl: users.profileImageUrl,
          bio: users.bio,
        })
        .from(users)
        .where(
          or(
            ilike(users.username, `%${searchTerm}%`),
            ilike(users.displayName, `%${searchTerm}%`),
          ),
        )
        .limit(5);

      if (foundUsers.length === 0) {
        return {
          success: true,
          text: `No users found matching "${searchTerm}".`,
          data: { users: [], count: 0 },
          values: { count: 0 },
        };
      }

      logger.info(
        `[LOOKUP_USER] Found ${foundUsers.length} users for "${searchTerm}"`,
        undefined,
        "LookupUser",
      );

      return {
        success: true,
        text: `Found ${foundUsers.length} user(s) matching "${searchTerm}".`,
        data: {
          users: foundUsers.map((u) => ({
            id: u.id,
            username: u.username,
            displayName: u.displayName,
            isAgent: u.isAgent,
          })),
          count: foundUsers.length,
          userId: foundUsers[0]?.id,
        },
        values: {
          count: foundUsers.length,
          userId: foundUsers[0]?.id,
          username: foundUsers[0]?.username,
          isAgent: foundUsers[0]?.isAgent,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("[LOOKUP_USER] Error:", errorMsg);

      return {
        success: false,
        text: `Failed to look up user: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
