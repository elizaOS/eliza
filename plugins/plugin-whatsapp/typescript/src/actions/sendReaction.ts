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

export const WHATSAPP_SEND_REACTION_ACTION = "WHATSAPP_SEND_REACTION";

const REACTION_TEMPLATE = `
You are extracting WhatsApp reaction parameters from a conversation.

The user wants to react to a WhatsApp message. Extract the following:
1. messageId: The ID of the message to react to
2. emoji: The emoji to use as a reaction

{{recentMessages}}

Based on the conversation, extract the reaction parameters.

Respond with a JSON object:
{
  "messageId": "wamid.xxx",
  "emoji": "👍"
}
`;

interface ReactionParams {
  messageId: string;
  emoji: string;
}

export const sendReactionAction: Action = {
  name: WHATSAPP_SEND_REACTION_ACTION,
  similes: ["WHATSAPP_REACT", "REACT_WHATSAPP", "WHATSAPP_EMOJI"],
  description: "Send a reaction emoji to a WhatsApp message",

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const source = message.content?.source;
    return source === "whatsapp";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    // Get WhatsApp settings
    const accessToken = runtime.getSetting("WHATSAPP_ACCESS_TOKEN") as string;
    const phoneNumberId = runtime.getSetting("WHATSAPP_PHONE_NUMBER_ID") as string;
    const apiVersion = (runtime.getSetting("WHATSAPP_API_VERSION") as string) || "v18.0";

    if (!accessToken || !phoneNumberId) {
      if (callback) {
        await callback({
          text: "WhatsApp is not configured. Missing access token or phone number ID.",
        });
      }
      return { success: false, error: "WhatsApp not configured" };
    }

    const currentState = state ?? (await runtime.composeState(message));

    // Extract reaction parameters using LLM
    const prompt = composePromptFromState({
      state: currentState,
      template: REACTION_TEMPLATE,
    });

    let params: ReactionParams;
    try {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseJSONObjectFromText(response) as unknown as ReactionParams | null;
      if (!parsed || !parsed.messageId || !parsed.emoji) {
        // Try to use context from message
        const messageId = message.content?.messageId as string;
        if (!messageId) {
          if (callback) {
            await callback({
              text: "Could not determine which message to react to",
            });
          }
          return { success: false, error: "Missing message ID" };
        }
        params = { messageId, emoji: "👍" }; // Default to thumbs up
      } else {
        params = parsed;
      }
    } catch {
      if (callback) {
        await callback({
          text: "Failed to parse reaction parameters",
        });
      }
      return { success: false, error: "Failed to parse reaction parameters" };
    }

    // Get the recipient (sender of the original message)
    const to = message.content?.from as string;
    if (!to) {
      if (callback) {
        await callback({
          text: "Could not determine the recipient for the reaction",
        });
      }
      return { success: false, error: "Missing recipient" };
    }

    // Send the reaction via WhatsApp Cloud API
    try {
      const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "reaction",
          reaction: {
            message_id: params.messageId,
            emoji: params.emoji,
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || `HTTP ${response.status}`);
      }

      if (callback) {
        await callback({
          text: `Reacted with ${params.emoji}`,
          action: WHATSAPP_SEND_REACTION_ACTION,
        });
      }

      return {
        success: true,
        data: {
          action: WHATSAPP_SEND_REACTION_ACTION,
          messageId: params.messageId,
          emoji: params.emoji,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (callback) {
        await callback({
          text: `Failed to send reaction: ${errorMessage}`,
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
          text: "React with a thumbs up",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll add that reaction.",
          actions: [WHATSAPP_SEND_REACTION_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
