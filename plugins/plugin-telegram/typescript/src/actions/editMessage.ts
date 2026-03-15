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

export const EDIT_MESSAGE_ACTION = "TELEGRAM_EDIT_MESSAGE";

const EDIT_EXTRACTION_TEMPLATE = `
You are extracting edit parameters from a conversation.

The user wants to edit a Telegram message. Extract the following:
1. messageId: The message ID to edit (required)
2. text: The new text content for the message (required)

{{recentMessages}}

Based on the conversation, extract the edit parameters.

Respond with a JSON object:
{
  "messageId": number,
  "text": "new message text"
}
`;

interface EditParams {
  messageId: number;
  text: string;
}

export const editMessageAction: Action = {
  name: EDIT_MESSAGE_ACTION,
  similes: [
    "TELEGRAM_EDIT",
    "EDIT_TELEGRAM_MESSAGE",
    "UPDATE_MESSAGE",
    "MODIFY_MESSAGE",
  ],
  description: "Edit an existing Telegram message",

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

    // Extract edit parameters using LLM
    const prompt = composePromptFromState({
      state: currentState,
      template: EDIT_EXTRACTION_TEMPLATE,
    });

    let params: EditParams;
    try {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseJSONObjectFromText(response) as unknown as EditParams | null;
      if (!parsed || !parsed.messageId || !parsed.text) {
        if (callback) {
          await callback({
            text: "Could not determine which message to edit or what to change it to",
          });
        }
        return { success: false, error: "Missing edit parameters" };
      }
      params = parsed;
    } catch (error) {
      if (callback) {
        await callback({
          text: "Failed to parse edit parameters",
        });
      }
      return { success: false, error: "Failed to parse edit parameters" };
    }

    // Edit the message using the service's public method
    const result = await telegramService.editMessage({
      chatId,
      messageId: params.messageId,
      text: params.text,
    });

    if (result.success) {
      if (callback) {
        await callback({
          text: `Message edited successfully`,
          action: EDIT_MESSAGE_ACTION,
        });
      }
      return {
        success: true,
        data: {
          action: EDIT_MESSAGE_ACTION,
          chatId,
          messageId: params.messageId,
          newText: params.text,
        },
      };
    } else {
      if (callback) {
        await callback({
          text: `Failed to edit message: ${result.error}`,
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
          text: "Edit message 123 to say 'Hello updated!'",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll edit that message now.",
          actions: [EDIT_MESSAGE_ACTION],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Change my last message to 'Fixed typo'",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Updating the message content.",
          actions: [EDIT_MESSAGE_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
