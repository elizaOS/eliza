/**
 * Send reaction action for Google Chat plugin.
 */

import {
  type Action,
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import type { GoogleChatService } from "../service.js";
import { GOOGLE_CHAT_SERVICE_NAME } from "../types.js";

interface SendReactionParams {
  emoji: string;
  messageName: string;
  remove?: boolean;
}

const SEND_REACTION_TEMPLATE = `# Task: Extract Google Chat reaction parameters
Based on the conversation, determine the emoji reaction to add or remove.

Recent conversation:
{{recentMessages}}

Extract the following:
- emoji: The emoji to react with (Unicode emoji character)
- messageName: The message resource name to react to
- remove: Whether to remove the reaction (true/false)

Respond with a JSON object:
\`\`\`json
{
  "emoji": "👍",
  "messageName": "spaces/xxx/messages/yyy",
  "remove": false
}
\`\`\``;

export const sendReaction: Action = {
  name: "GOOGLE_CHAT_SEND_REACTION",
  similes: [
    "REACT_GOOGLE_CHAT",
    "GCHAT_REACT",
    "GOOGLE_CHAT_EMOJI",
    "ADD_GOOGLE_CHAT_REACTION",
  ],
  description: "Add or remove an emoji reaction to a Google Chat message",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return message.content.source === "google-chat";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const gchatService = runtime.getService<GoogleChatService>(
      GOOGLE_CHAT_SERVICE_NAME,
    );

    if (!gchatService || !gchatService.isConnected()) {
      if (callback) {
        callback({
          text: "Google Chat service is not available.",
          source: "google-chat",
        });
      }
      return { success: false, error: "Google Chat service not available" };
    }

    // Compose state if not provided
    const currentState = state ?? (await runtime.composeState(message));

    // Compose prompt
    const prompt = await composePromptFromState({
      template: SEND_REACTION_TEMPLATE,
      state: currentState,
    });

    // Extract parameters using LLM
    let reactionInfo: SendReactionParams | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseJSONObjectFromText(response);
      if (parsed?.emoji && parsed?.messageName) {
        reactionInfo = {
          emoji: String(parsed.emoji),
          messageName: String(parsed.messageName),
          remove: parsed.remove === true,
        };
        break;
      }
    }

    if (!reactionInfo) {
      if (callback) {
        callback({
          text: "I couldn't understand the reaction details. Please try again.",
          source: "google-chat",
        });
      }
      return { success: false, error: "Could not extract reaction parameters" };
    }

    // Get message name from state if not provided
    let targetMessage = reactionInfo.messageName;
    const messageData = currentState.data?.message as
      | Record<string, unknown>
      | undefined;
    if (!targetMessage && messageData?.name) {
      targetMessage = String(messageData.name);
    }

    if (!targetMessage) {
      if (callback) {
        callback({
          text: "I couldn't determine which message to react to. Please specify the message.",
          source: "google-chat",
        });
      }
      return { success: false, error: "Could not determine target message" };
    }

    // Handle remove case
    if (reactionInfo.remove) {
      const reactions = await gchatService.listReactions(targetMessage);
      const botUser = gchatService.getBotUser();
      const toRemove = reactions.filter((r) => {
        const userName = r.user?.name;
        if (botUser && userName !== botUser && userName !== "users/app") {
          return false;
        }
        if (reactionInfo?.emoji && r.emoji?.unicode !== reactionInfo?.emoji) {
          return false;
        }
        return true;
      });

      for (const reaction of toRemove) {
        if (reaction.name) {
          await gchatService.deleteReaction(reaction.name);
        }
      }

      if (callback) {
        callback({
          text: `Removed ${toRemove.length} reaction(s).`,
          source: message.content.source as string,
        });
      }

      return {
        success: true,
        data: {
          removed: toRemove.length,
        },
      };
    }

    // Add reaction
    const result = await gchatService.sendReaction(
      targetMessage,
      reactionInfo.emoji,
    );

    if (!result.success) {
      if (callback) {
        callback({
          text: `Failed to add reaction: ${result.error}`,
          source: "google-chat",
        });
      }
      return { success: false, error: result.error };
    }

    if (callback) {
      callback({
        text: `Added ${reactionInfo.emoji} reaction.`,
        source: message.content.source as string,
      });
    }

    return {
      success: true,
      data: {
        reactionName: result.name,
        emoji: reactionInfo.emoji,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "React with a thumbs up to that message" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll add a thumbs up reaction.",
          actions: ["GOOGLE_CHAT_SEND_REACTION"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Remove my reaction from that message" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll remove the reaction.",
          actions: ["GOOGLE_CHAT_SEND_REACTION"],
        },
      },
    ],
  ],
};
