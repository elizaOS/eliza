/**
 * Action to send a message to players in a Roblox game
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

const sendGameMessageExamples: ActionExample[][] = [
  [
    {
      name: "{{user1}}",
      content: {
        text: "Tell everyone in the game that there's a special event happening",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll announce the special event to all players in the game!",
        action: "SEND_ROBLOX_MESSAGE",
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: {
        text: "Send a message to player123 welcoming them to the game",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll send a personalized welcome message to player123.",
        action: "SEND_ROBLOX_MESSAGE",
      },
    },
  ],
];

/**
 * Action to send a message to players in a Roblox game
 */
const sendGameMessage: Action = {
  name: "SEND_ROBLOX_MESSAGE",
  similes: [
    "ROBLOX_MESSAGE",
    "GAME_MESSAGE",
    "SEND_TO_GAME",
    "BROADCAST_MESSAGE",
    "TELL_PLAYERS",
  ],
  description:
    "Send a message to players in a Roblox game. Can target all players or specific player IDs.",
  examples: sendGameMessageExamples,

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const apiKey = runtime.getSetting("ROBLOX_API_KEY");
    const universeId = runtime.getSetting("ROBLOX_UNIVERSE_ID");
    return Boolean(apiKey && universeId);
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
            text: "I couldn't connect to the Roblox service. Please make sure it's configured correctly.",
            action: "SEND_ROBLOX_MESSAGE",
          });
        }
        return false;
      }

      // Extract message content from state or message
      const messageContent =
        (state?.message as string) ||
        (message.content as { text?: string }).text ||
        "";

      if (!messageContent) {
        logger.warn("No message content to send");
        if (callback) {
          callback({
            text: "I need a message to send to the game.",
            action: "SEND_ROBLOX_MESSAGE",
          });
        }
        return false;
      }

      // Extract target player IDs if specified in the message
      const targetPlayerIds = extractPlayerIds(messageContent);

      // Send the message
      await service.sendMessage(runtime.agentId, messageContent, targetPlayerIds);

      logger.info(
        { targetPlayerIds, messageLength: messageContent.length },
        "Sent message to Roblox game"
      );

      if (callback) {
        const targetInfo =
          targetPlayerIds && targetPlayerIds.length > 0
            ? `to ${targetPlayerIds.length} specific player(s)`
            : "to all players";
        callback({
          text: `I've sent the message ${targetInfo} in the game.`,
          action: "SEND_ROBLOX_MESSAGE",
        });
      }

      return true;
    } catch (error) {
      logger.error({ error }, "Failed to send Roblox message");
      if (callback) {
        callback({
          text: "I encountered an error sending the message to the game. Please try again.",
          action: "SEND_ROBLOX_MESSAGE",
        });
      }
      return false;
    }
  },
};

/**
 * Extract player IDs from a message (looks for patterns like "player123" or explicit IDs)
 */
function extractPlayerIds(message: string): number[] | undefined {
  // Look for explicit player IDs (numbers)
  const playerIdPattern = /\bplayer\s*(\d+)\b/gi;
  const matches = [...message.matchAll(playerIdPattern)];

  if (matches.length > 0) {
    return matches.map((m) => parseInt(m[1], 10));
  }

  return undefined;
}

export default sendGameMessage;


