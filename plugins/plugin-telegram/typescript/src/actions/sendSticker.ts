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
import { composePromptFromState, ModelType, parseJSONObjectFromText } from "@elizaos/core";
import { TELEGRAM_SERVICE_NAME } from "../constants";
import type { TelegramService } from "../service";

export const SEND_STICKER_ACTION = "TELEGRAM_SEND_STICKER";

const STICKER_EXTRACTION_TEMPLATE = `
You are extracting sticker parameters from a conversation.

The user wants to send a sticker on Telegram. Extract the following:
1. fileId: The sticker file ID (if provided)
2. emoji: The emoji that best represents the intended sticker (if no fileId)

Common emoji for stickers: 👍 👎 ❤ 🔥 🎉 😢 🤔 😂 😱 🥺 🤗 🙏 👏 💪 🎊

{{recentMessages}}

Based on the conversation, extract the sticker parameters.

Respond with a JSON object:
{
  "fileId": "sticker file ID or null",
  "emoji": "emoji representing the sticker"
}
`;

interface StickerParams {
  fileId?: string;
  emoji?: string;
}

export const sendStickerAction: Action = {
  name: SEND_STICKER_ACTION,
  similes: [
    "TELEGRAM_STICKER",
    "SEND_TELEGRAM_STICKER",
    "POST_STICKER",
  ],
  description: "Send a sticker to a Telegram chat. Requires a sticker file_id. To get a sticker's file_id, forward the sticker to @RawDataBot on Telegram.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const source = message.content?.source;
    if (source !== "telegram") return false;
    
    // Check if telegram service is available and initialized
    const telegramService = runtime.getService(TELEGRAM_SERVICE_NAME) as TelegramService | undefined;
    return telegramService?.isInitialized() ?? false;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
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

    const chatId = message.content?.chatId as number | string | undefined;
    if (!chatId) {
      if (callback) {
        await callback({
          text: "No chat ID available",
        });
      }
      return { success: false, error: "Missing chat ID" };
    }

    const currentState = state ?? (await runtime.composeState(message));

    // Extract sticker parameters using LLM
    const prompt = composePromptFromState({
      state: currentState,
      template: STICKER_EXTRACTION_TEMPLATE,
    });

    let params: StickerParams;
    try {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseJSONObjectFromText(response) as unknown as StickerParams | null;
      if (!parsed) {
        if (callback) {
          await callback({
            text: "Could not determine which sticker to send",
          });
        }
        return { success: false, error: "Missing sticker parameters" };
      }
      params = parsed;
    } catch {
      if (callback) {
        await callback({
          text: "Failed to parse sticker parameters",
        });
      }
      return { success: false, error: "Failed to parse sticker parameters" };
    }

    if (!params.fileId) {
      if (callback) {
        await callback({
          text: "No sticker file ID provided. To send a sticker, I need a file ID. You can get sticker file IDs by forwarding a sticker to @RawDataBot on Telegram.",
        });
      }
      return { success: false, error: "No sticker file ID provided" };
    }

    // Send the sticker using the service's public method
    const replyToMessageId = message.content?.messageId as number | undefined;
    const threadId = message.content?.threadId as number | undefined;
    
    const result = await telegramService.sendSticker({
      chatId,
      sticker: params.fileId,
      replyToMessageId,
      threadId,
    });

    if (result.success) {
      if (callback) {
        await callback({
          text: `Sticker sent!`,
          action: SEND_STICKER_ACTION,
        });
      }
      return {
        success: true,
        data: {
          action: SEND_STICKER_ACTION,
          chatId,
          messageId: result.messageId,
          fileId: params.fileId,
        },
      };
    } else {
      if (callback) {
        await callback({
          text: `Failed to send sticker: ${result.error}`,
        });
      }
      return { success: false, error: result.error };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send sticker CAACAgIAAxkBAAIBXGVc... (with actual file_id)",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send that sticker now.",
          actions: [SEND_STICKER_ACTION],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "How do I get a sticker file_id?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "To get a sticker's file_id, forward the sticker to @RawDataBot on Telegram. It will reply with the sticker's file_id that you can use with me.",
        },
      },
    ],
  ] as ActionExample[][],
};
