/**
 * Check Team Chat Action (Coordinator)
 *
 * Allows coordinator to view recent messages from the team chat.
 * Useful for getting context about the full conversation history.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { db, desc, eq, messages, users } from "@feed/db";
import { COORDINATOR_INFO, COORDINATOR_SENDER_ID } from "@feed/shared";
import { logger } from "../../../../shared/logger";

/** Options for check team chat action */
interface CheckTeamChatOptions extends HandlerOptions {
  limit?: number;
}

export const checkTeamChatAction: Action = {
  name: "CHECK_TEAM_CHAT",
  description:
    "View recent messages from the team chat. Use this to see the full conversation history including what agents have said.",
  parameters: {
    limit: {
      type: "number",
      description: "Number of recent messages to fetch (default: 20, max: 50)",
      optional: true,
    },
  } as unknown as Action["parameters"],
  examples: [
    [
      {
        name: "user",
        content: { text: "Show me the conversation history" },
      },
      {
        name: "coordinator",
        content: { text: "I'll check the team chat for recent messages." },
      },
    ],
    [
      {
        name: "user",
        content: { text: "What did my agents say?" },
      },
      {
        name: "coordinator",
        content: { text: "Let me look at the team chat history." },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: CheckTeamChatOptions,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const teamChatId = state?.values?.teamChatId as string | undefined;

    if (!teamChatId) {
      return {
        success: false,
        text: "This action is only available in team chat mode.",
        error: "No team chat ID provided",
      };
    }

    // Get limit from action params
    const actionParams = state?.data?.actionParams as
      | { limit?: number }
      | undefined;
    const requestedLimit = actionParams?.limit ?? 20;
    const limit = Math.min(Math.max(1, requestedLimit), 50);

    try {
      // Fetch recent messages from team chat
      const recentMessages = await db
        .select({
          id: messages.id,
          content: messages.content,
          senderId: messages.senderId,
          createdAt: messages.createdAt,
          senderDisplayName: users.displayName,
          senderUsername: users.username,
          isAgent: users.isAgent,
        })
        .from(messages)
        .leftJoin(users, eq(messages.senderId, users.id))
        .where(eq(messages.chatId, teamChatId))
        .orderBy(desc(messages.createdAt))
        .limit(limit);

      // Reverse to show oldest first
      const chronologicalMessages = recentMessages.reverse();

      // Format messages for LLM context (values)
      const formattedMessages = chronologicalMessages.map((msg) => {
        // Handle coordinator messages
        if (msg.senderId === COORDINATOR_SENDER_ID) {
          return {
            sender: `${COORDINATOR_INFO.displayName} @${COORDINATOR_INFO.username}`,
            role: "Coordinator",
            content: msg.content,
            time: new Date(msg.createdAt).toLocaleTimeString(),
          };
        }

        const senderName =
          msg.senderDisplayName || msg.senderUsername || "Unknown";
        const senderHandle = msg.senderUsername ? `@${msg.senderUsername}` : "";
        const timestamp = new Date(msg.createdAt).toLocaleTimeString();
        // Explicitly handle null (deleted users) vs true/false
        const role =
          msg.isAgent === true
            ? "Agent"
            : msg.isAgent === false
              ? "User"
              : "Unknown";

        return {
          sender: `${senderName} ${senderHandle}`.trim(),
          role,
          content: msg.content,
          time: timestamp,
        };
      });

      // Text formatted for display
      const displayText = formattedMessages
        .map((m) => `[${m.time}] ${m.sender} (${m.role}): ${m.content}`)
        .join("\n\n");

      logger.info("[CHECK_TEAM_CHAT] Retrieved messages", {
        teamChatId,
        messageCount: chronologicalMessages.length,
      });

      return {
        success: true,
        text: `Retrieved ${chronologicalMessages.length} messages from team chat.`,
        data: {
          messages: chronologicalMessages,
          count: chronologicalMessages.length,
        },
        values: {
          messageCount: chronologicalMessages.length,
          conversationText: displayText || "No messages yet.",
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("[CHECK_TEAM_CHAT] Error:", errorMsg);
      return {
        success: false,
        text: `Failed to check team chat: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
