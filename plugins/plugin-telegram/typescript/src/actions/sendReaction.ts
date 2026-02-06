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
import { TELEGRAM_REACTIONS } from "../types";

export const SEND_REACTION_ACTION = "SEND_TELEGRAM_REACTION";

const REACTION_EXTRACTION_TEMPLATE = `
You are extracting reaction parameters from a conversation.

The user wants to react to a Telegram message. Extract the following:
1. reaction: The emoji to use as a reaction (must be a valid Telegram reaction emoji)
2. messageId: The message ID to react to (if specified, otherwise use the current message)
3. isBig: Whether to use a big/animated reaction (default: false)

Valid Telegram reaction emojis include:
👍 👎 ❤ 🔥 🎉 😢 🤔 🤯 😱 🤬 💀 💩 🤡 🤨 👀 🐳 ❤️‍🔥 🌚 🌭 💯 😂 ⚡ 🍌 🏆 💔 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 🦄

{{recentMessages}}

Based on the conversation, extract the reaction parameters.
If the user mentions "thumbs up", "like", or similar, use 👍.
If the user mentions "heart", "love", use ❤.
If the user mentions "fire", "lit", use 🔥.
If the user doesn't specify a message, react to their current message.

Respond with a JSON object:
{
  "reaction": "emoji here",
  "messageId": number or null,
  "isBig": boolean
}
`;

interface ReactionParams {
  reaction: string;
  messageId?: number;
  isBig?: boolean;
}

export const sendReactionAction: Action = {
  name: SEND_REACTION_ACTION,
  similes: [
    "TELEGRAM_REACT",
    "TELEGRAM_REACTION",
    "REACT_TO_MESSAGE",
    "ADD_REACTION",
    "SEND_EMOJI",
    "TELEGRAM_EMOJI",
  ],
  description: "Send a reaction emoji to a Telegram message",

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const source = message.content?.source;
    return source === "telegram";
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

    // Extract reaction parameters using LLM
    const prompt = composePromptFromState({
      state: currentState,
      template: REACTION_EXTRACTION_TEMPLATE,
    });

    let params: ReactionParams;
    try {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseJSONObjectFromText(response) as unknown as ReactionParams | null;
      if (!parsed || !parsed.reaction) {
        // Default to thumbs up if we can't parse
        params = {
          reaction: TELEGRAM_REACTIONS.THUMBS_UP,
          isBig: false,
        };
      } else {
        params = parsed;
      }
    } catch {
      // Default to thumbs up on error
      params = {
        reaction: TELEGRAM_REACTIONS.THUMBS_UP,
        isBig: false,
      };
    }

    // Use current message ID if not specified
    const targetMessageId = params.messageId ?? (message.content?.messageId as number | undefined);
    if (!targetMessageId) {
      if (callback) {
        await callback({
          text: "No message ID available to react to",
        });
      }
      return { success: false, error: "Missing message ID" };
    }

    // Send the reaction
    const result = await telegramService.sendReaction({
      chatId,
      messageId: targetMessageId,
      reaction: params.reaction,
      isBig: params.isBig,
    });

    if (result.success) {
      if (callback) {
        await callback({
          text: `Reacted with ${params.reaction}`,
          action: SEND_REACTION_ACTION,
        });
      }
      return {
        success: true,
        data: {
          action: SEND_REACTION_ACTION,
          chatId,
          messageId: targetMessageId,
          reaction: params.reaction,
        },
      };
    } else {
      if (callback) {
        await callback({
          text: `Failed to send reaction: ${result.error}`,
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
          text: "React to my message with a thumbs up",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll add a thumbs up reaction to your message.",
          actions: [SEND_REACTION_ACTION],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Give that a heart reaction",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Adding a heart reaction now.",
          actions: [SEND_REACTION_ACTION],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "🔥 that message",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll react with the fire emoji.",
          actions: [SEND_REACTION_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
