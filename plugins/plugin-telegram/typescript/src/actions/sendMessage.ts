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
import { TELEGRAM_SERVICE_NAME } from "../constants";
import type { TelegramService } from "../service";

export const SEND_MESSAGE_ACTION = "SEND_TELEGRAM_MESSAGE";

export const sendMessageAction: Action = {
  name: SEND_MESSAGE_ACTION,
  similes: [
    "TELEGRAM_SEND_MESSAGE",
    "TELEGRAM_REPLY",
    "TELEGRAM_MESSAGE",
    "SEND_TELEGRAM",
    "REPLY_TELEGRAM",
  ],
  description: "Send a message to a Telegram chat",

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const source = message.content?.source;
    return source === "telegram";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const telegramService = runtime.getService(TELEGRAM_SERVICE_NAME) as
      | TelegramService
      | undefined;
    if (!telegramService) {
      if (callback) {
        await callback({
          text: "Telegram service not available",
        });
      }
      return { success: false, error: "Telegram service not initialized" };
    }

    const responseText = state.values?.response?.toString() || "";
    const chatId = message.content?.chatId;

    if (!chatId) {
      if (callback) {
        await callback({
          text: "No chat ID available",
        });
      }
      return { success: false, error: "Missing chat ID" };
    }

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
        chatId,
        text: responseText,
        replyToMessageId: message.content?.messageId,
      },
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send a message to this Telegram chat",
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
