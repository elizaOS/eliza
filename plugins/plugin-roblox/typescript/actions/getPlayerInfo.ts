import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { RobloxService } from "../services/RobloxService";
import { ROBLOX_SERVICE_NAME, type RobloxUser } from "../types";

const actionName = "GET_ROBLOX_PLAYER";

const getPlayerInfoExamples: ActionExample[][] = [
  [
    {
      name: actionName,
      content: {
        text: "Who is player 12345678?",
      },
    },
    {
      name: actionName,
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

function extractUserIdentifier(
  message: string
): { type: "id"; value: number } | { type: "username"; value: string } | null {
  const idMatch = message.match(/\b(?:player|user|id)\s*[:#]?\s*(\d{5,})\b/i);
  if (idMatch) {
    return { type: "id", value: parseInt(idMatch[1], 10) };
  }

  const usernameMatch = message.match(
    /\b(?:user(?:name)?|player)\s*[:#]?\s*([A-Za-z0-9_]{3,20})\b/i
  );
  if (usernameMatch) {
    const username = usernameMatch[1];
    if (!/^\d+$/.test(username)) {
      return { type: "username", value: username };
    }
  }

  return null;
}

const getPlayerInfo: Action = {
  name: actionName,
  similes: [],
  description: "Fetch Roblox player information by username or user id.",
  examples: getPlayerInfoExamples,

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const apiKey = runtime.getSetting("ROBLOX_API_KEY");
    return Boolean(apiKey);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
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
        return {
          success: false,
          error: "Roblox service not found",
        };
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
        return {
          success: false,
          error: "Roblox client not found for agent",
        };
      }

      const messageContent =
        (state?.message as string) || (message.content as { text?: string }).text || "";

      const identifier = extractUserIdentifier(messageContent);

      if (!identifier) {
        logger.warn("Could not extract user identifier from message");
        if (callback) {
          callback({
            text: "I need a player ID or username to look up. Please provide one.",
            action: "GET_ROBLOX_PLAYER",
          });
        }
        return {
          success: false,
          error: "Could not extract user identifier from message",
        };
      }

      let user: RobloxUser | null;
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
        return {
          success: true,
          text: `User not found with ${identifier.type === "id" ? "ID" : "username"}: ${identifier.value}`,
        };
      }

      const avatarUrl = await client.getAvatarUrl(user.id);
      user.avatarUrl = avatarUrl;

      logger.info({ userId: user.id, username: user.username }, "Found Roblox user");

      if (callback) {
        const createdDate = user.createdAt ? user.createdAt.toLocaleDateString() : "Unknown";
        const bannedStatus = user.isBanned ? " (Banned)" : "";

        callback({
          text: `**${user.displayName}** (@${user.username})${bannedStatus}
- User ID: ${user.id}
- Account created: ${createdDate}`,
          action: "GET_ROBLOX_PLAYER",
        });
      }

      return {
        success: true,
        text: `Found Roblox user: ${user.displayName} (@${user.username})`,
        data: {
          userId: user.id,
          username: user.username,
          displayName: user.displayName,
          avatarUrl: avatarUrl || undefined,
          isBanned: user.isBanned,
          createdAt: user.createdAt ? user.createdAt.toISOString() : undefined,
        },
      };
    } catch (error) {
      logger.error({ error }, "Failed to get Roblox player info");
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      if (callback) {
        callback({
          text: "I encountered an error looking up that player. Please try again.",
          action: "GET_ROBLOX_PLAYER",
        });
      }
      return {
        success: false,
        error: errorMessage,
      };
    }
  },
};

export default getPlayerInfo;
