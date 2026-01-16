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
import { ROBLOX_SERVICE_NAME } from "../types";

const actionName = "SEND_ROBLOX_MESSAGE";

const sendGameMessageExamples: ActionExample[][] = [
  [
    {
      name: actionName,
      content: {
        text: "Tell everyone in the game that there's a special event happening",
      },
    },
    {
      name: actionName,
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

const sendGameMessage: Action = {
  name: actionName,
  similes: [],
  description: "Send a message to players in the Roblox game.",
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
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    try {
      const service = runtime.getService<RobloxService>(ROBLOX_SERVICE_NAME);
      if (!service) {
        logger.error("Roblox service not found");
        if (callback) {
          callback({
            text: "Roblox service not available.",
            action: "SEND_ROBLOX_MESSAGE",
          });
        }
        return {
          success: false,
          error: "Roblox service not found",
        };
      }

      const messageContent =
        (state?.message as string) || (message.content as { text?: string }).text || "";

      if (!messageContent) {
        logger.warn("No message content to send");
        if (callback) {
          callback({
            text: "I need a message to send to the game.",
            action: "SEND_ROBLOX_MESSAGE",
          });
        }
        return {
          success: false,
          error: "No message content to send",
        };
      }

      const targetPlayerIds = extractPlayerIds(messageContent);

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

      return {
        success: true,
        text: `Sent message ${targetPlayerIds && targetPlayerIds.length > 0 ? `to ${targetPlayerIds.length} specific player(s)` : "to all players"} in the game`,
        data: {
          targetPlayerIds,
          messageLength: messageContent.length,
        },
      };
    } catch (error) {
      logger.error({ error }, "Failed to send Roblox message");
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      if (callback) {
        callback({
          text: "Error sending message.",
          action: "SEND_ROBLOX_MESSAGE",
        });
      }
      return {
        success: false,
        error: errorMessage,
      };
    }
  },
};

function extractPlayerIds(message: string): number[] | undefined {
  const playerIdPattern = /\bplayer\s*(\d+)\b/gi;
  const matches = [...message.matchAll(playerIdPattern)];

  if (matches.length > 0) {
    return matches.map((m) => parseInt(m[1], 10));
  }

  return undefined;
}

export default sendGameMessage;
