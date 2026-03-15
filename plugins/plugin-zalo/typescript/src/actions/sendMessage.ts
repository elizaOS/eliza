import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ZALO_SERVICE_NAME } from "../constants";
import type { ZaloService } from "../service";

export const SEND_MESSAGE_ACTION = "SEND_ZALO_MESSAGE";

export const sendMessageAction: Action = {
  name: SEND_MESSAGE_ACTION,
  similes: [
    "ZALO_SEND_MESSAGE",
    "ZALO_REPLY",
    "ZALO_MESSAGE",
    "SEND_ZALO",
    "REPLY_ZALO",
  ],
  description: "Send a message to a Zalo user",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const source = message.content?.source;
    return source === "zalo";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const zaloService = (await runtime.getService(ZALO_SERVICE_NAME)) as
      | ZaloService
      | undefined;

    if (!zaloService) {
      if (callback) {
        await callback({
          text: "Zalo service not available",
        });
      }
      return { success: false, error: "Zalo service not initialized" };
    }

    const responseText = state?.values?.response?.toString() || "";
    const userId = message.content?.userId || message.content?.chatId;

    if (!userId) {
      if (callback) {
        await callback({
          text: "No user ID available",
        });
      }
      return { success: false, error: "Missing user ID" };
    }

    try {
      const messageId = await zaloService.sendTextMessage(
        userId as string,
        responseText,
      );

      if (callback) {
        await callback({
          text: responseText,
          action: SEND_MESSAGE_ACTION,
        });
      }

      return {
        success: true,
        data: {
          action: SEND_MESSAGE_ACTION,
          userId,
          text: responseText,
          messageId,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (callback) {
        await callback({
          text: `Failed to send message: ${errorMessage}`,
        });
      }
      return { success: false, error: errorMessage };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send a message to this Zalo chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send a message to this chat now.",
          actions: [SEND_MESSAGE_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
