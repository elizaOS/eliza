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

export const DELETE_MESSAGE_ACTION = "TELEGRAM_DELETE_MESSAGE";

const DELETE_EXTRACTION_TEMPLATE = `
You are extracting delete parameters from a conversation.

The user wants to delete a Telegram message. Extract the following:
1. messageId: The message ID to delete (required)

{{recentMessages}}

Based on the conversation, extract the message ID to delete.

Respond with a JSON object:
{
  "messageId": number
}
`;

interface DeleteParams {
  messageId: number;
}

export const deleteMessageAction: Action = {
  name: DELETE_MESSAGE_ACTION,
  similes: [
    "TELEGRAM_DELETE",
    "DELETE_TELEGRAM_MESSAGE",
    "REMOVE_MESSAGE",
    "UNSEND_MESSAGE",
  ],
  description: "Delete a Telegram message",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const source = message.content?.source;
    if (source !== "telegram") return false;
    
    // Check if telegram service is available and initialized
    const telegramService = await runtime.getService(TELEGRAM_SERVICE_NAME) as TelegramService | undefined;
    return telegramService?.isInitialized() ?? false;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const telegramService = await runtime.getService(TELEGRAM_SERVICE_NAME) as
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

    const chatId = message.content?.chatId as number | undefined;
    if (!chatId) {
      if (callback) {
        await callback({
          text: "No chat ID available",
        });
      }
      return { success: false, error: "Missing chat ID" };
    }

    const currentState = state ?? (await runtime.composeState(message));

    // Extract delete parameters using LLM
    const prompt = composePromptFromState({
      state: currentState,
      template: DELETE_EXTRACTION_TEMPLATE,
    });

    let params: DeleteParams;
    try {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseJSONObjectFromText(response) as unknown as DeleteParams | null;
      if (!parsed || !parsed.messageId) {
        // Try to use the current message ID
        const currentMessageId = message.content?.messageId as number | undefined;
        if (currentMessageId) {
          params = { messageId: currentMessageId };
        } else {
          if (callback) {
            await callback({
              text: "Could not determine which message to delete",
            });
          }
          return { success: false, error: "Missing message ID" };
        }
      } else {
        params = parsed;
      }
    } catch {
      // Try to use the current message ID on parse error
      const currentMessageId = message.content?.messageId as number | undefined;
      if (currentMessageId) {
        params = { messageId: currentMessageId };
      } else {
        if (callback) {
          await callback({
            text: "Failed to determine which message to delete",
          });
        }
        return { success: false, error: "Failed to parse delete parameters" };
      }
    }

    // Delete the message using the service's public method
    const result = await telegramService.deleteMessage({
      chatId,
      messageId: params.messageId,
    });

    if (result.success) {
      if (callback) {
        await callback({
          text: `Message deleted successfully`,
          action: DELETE_MESSAGE_ACTION,
        });
      }
      return {
        success: true,
        data: {
          action: DELETE_MESSAGE_ACTION,
          chatId,
          messageId: params.messageId,
        },
      };
    } else {
      if (callback) {
        await callback({
          text: `Failed to delete message: ${result.error}`,
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
          text: "Delete message 123",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll delete that message now.",
          actions: [DELETE_MESSAGE_ACTION],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Remove my last message",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Deleting the message.",
          actions: [DELETE_MESSAGE_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
