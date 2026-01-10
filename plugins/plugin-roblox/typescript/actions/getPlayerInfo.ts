/**
 * Action to get information about a Roblox player
 */

import {
  type Action,
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import { RobloxService } from "../services/RobloxService";
import { ROBLOX_SERVICE_NAME } from "../types";

const getPlayerInfoExamples: ActionExample[][] = [
  [
    {
      name: "{{user1}}",
      content: {
        text: "Who is player 12345678?",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Let me look up that player's information for you.",
        action: "GET_ROBLOX_PLAYER",
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: {
        text: "Look up the Roblox user JohnDoe123",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll find the information for JohnDoe123.",
        action: "GET_ROBLOX_PLAYER",
      },
    },
  ],
];

/**
 * Extract user ID or username from a message
 */
function extractUserIdentifier(
  message: string
): { type: "id"; value: number } | { type: "username"; value: string } | null {
  // Check for numeric ID
  const idMatch = message.match(/\b(?:player|user|id)\s*[:#]?\s*(\d{5,})\b/i);
  if (idMatch) {
    return { type: "id", value: parseInt(idMatch[1], 10) };
  }

  // Check for username
  const usernameMatch = message.match(
    /\b(?:user(?:name)?|player)\s*[:#]?\s*([A-Za-z0-9_]{3,20})\b/i
  );
  if (usernameMatch) {
    const username = usernameMatch[1];
    // Make sure it's not just a number
    if (!/^\d+$/.test(username)) {
      return { type: "username", value: username };
    }
  }

  return null;
}

/**
 * Action to get information about a Roblox player
 */
const getPlayerInfo: Action = {
  name: "GET_ROBLOX_PLAYER",
  similes: [
    "LOOKUP_PLAYER",
    "FIND_PLAYER",
    "PLAYER_INFO",
    "WHO_IS_PLAYER",
    "ROBLOX_USER_INFO",
  ],
  description:
    "Look up information about a Roblox player by their user ID or username.",
  examples: getPlayerInfoExamples,

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const apiKey = runtime.getSetting("ROBLOX_API_KEY");
    return Boolean(apiKey);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      const service = runtime.getService<RobloxService>(ROBLOX_SERVICE_NAME);
      if (!service) {
        logger.error("Roblox service not found");
        if (callback) {
          callback({
            text: "I couldn't connect to the Roblox service.",
            action: "GET_ROBLOX_PLAYER",
          });
        }
        return false;
      }

      const client = service.getClient(runtime.agentId);
      if (!client) {
        logger.error("Roblox client not found for agent");
        if (callback) {
          callback({
            text: "The Roblox client isn't available right now.",
            action: "GET_ROBLOX_PLAYER",
          });
        }
        return false;
      }

      // Extract user identifier from message
      const messageContent =
        (state?.message as string) ||
        (message.content as { text?: string }).text ||
        "";

      const identifier = extractUserIdentifier(messageContent);

      if (!identifier) {
        logger.warn("Could not extract user identifier from message");
        if (callback) {
          callback({
            text: "I need a player ID or username to look up. Please provide one.",
            action: "GET_ROBLOX_PLAYER",
          });
        }
        return false;
      }

      // Look up the user
      let user;
      if (identifier.type === "id") {
        user = await client.getUserById(identifier.value);
      } else {
        user = await client.getUserByUsername(identifier.value);
      }

      if (!user) {
        if (callback) {
          callback({
            text: `I couldn't find a Roblox user with that ${identifier.type === "id" ? "ID" : "username"}.`,
            action: "GET_ROBLOX_PLAYER",
          });
        }
        return true;
      }

      // Get avatar URL
      const avatarUrl = await client.getAvatarUrl(user.id);
      user.avatarUrl = avatarUrl;

      logger.info({ userId: user.id, username: user.username }, "Found Roblox user");

      if (callback) {
        const createdDate = user.createdAt
          ? user.createdAt.toLocaleDateString()
          : "Unknown";
        const bannedStatus = user.isBanned ? " (Banned)" : "";

        callback({
          text: `**${user.displayName}** (@${user.username})${bannedStatus}
- User ID: ${user.id}
- Account created: ${createdDate}`,
          action: "GET_ROBLOX_PLAYER",
        });
      }

      return true;
    } catch (error) {
      logger.error({ error }, "Failed to get Roblox player info");
      if (callback) {
        callback({
          text: "I encountered an error looking up that player. Please try again.",
          action: "GET_ROBLOX_PLAYER",
        });
      }
      return false;
    }
  },
};

export default getPlayerInfo;

