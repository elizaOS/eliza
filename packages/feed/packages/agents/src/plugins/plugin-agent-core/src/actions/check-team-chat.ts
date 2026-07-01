/**
 * Check Team Chat Action
 * Allows agents to view recent messages from the team chat
 * Useful when agents want to see what other agents have said
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { db, desc, eq, messages, users } from "@feed/db";
import { COORDINATOR_INFO, COORDINATOR_SENDER_ID } from "@feed/shared";
import { logger } from "../../../../shared/logger";
import { defineActionParameters } from "../../../shared/action-parameters";

export const checkTeamChatAction: Action = {
  name: "CHECK_TEAM_CHAT",
  description:
    "View recent messages from the team Agents chat. Use this to see what other agents have said or to get context about the ongoing discussion.",
  parameters: defineActionParameters({
    limit: {
      type: "number",
      description: "Number of recent messages to fetch (default: 10, max: 50)",
      optional: true,
    },
  }),
  examples: [
    [
      {
        name: "user",
        content: { text: "Check what other agents said" },
      },
      {
        name: "assistant",
        content: { text: "I'll check the team chat for recent messages." },
      },
    ],
    [
      {
        name: "user",
        content: { text: "See the team conversation" },
      },
      {
        name: "assistant",
        content: { text: "Let me look at the team chat history." },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // Always validate - the handler will check if teamChatId is available
    // This ensures the action appears in the list even when teamChatId
    // is set after composeState (which runs actionsProvider)
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const agentUserId = runtime.agentId;
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
    const requestedLimit = actionParams?.limit ?? 10;
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
        const timestamp = new Date(msg.createdAt).toLocaleTimeString();

        // Handle coordinator messages
        if (msg.senderId === COORDINATOR_SENDER_ID) {
          return {
            sender: `${COORDINATOR_INFO.displayName} @${COORDINATOR_INFO.username}`,
            role: "Coordinator",
            content: msg.content,
            time: timestamp,
          };
        }

        const senderName =
          msg.senderDisplayName || msg.senderUsername || "Unknown";
        const senderHandle = msg.senderUsername ? `@${msg.senderUsername}` : "";
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
        agentUserId,
        teamChatId,
        messageCount: chronologicalMessages.length,
      });

      return {
        success: true,
        // text = status summary
        text: `Retrieved ${chronologicalMessages.length} messages from team chat.`,
        // data = full raw data for logging
        data: {
          messages: chronologicalMessages,
          count: chronologicalMessages.length,
        },
        // values = structured data for LLM reasoning
        values: {
          messageCount: chronologicalMessages.length,
          // Also provide as formatted text for easy reading
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
