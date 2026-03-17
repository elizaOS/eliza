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

export const WHATSAPP_SEND_MESSAGE_ACTION = "WHATSAPP_SEND_MESSAGE";

const SEND_MESSAGE_TEMPLATE = `
You are extracting WhatsApp message parameters from a conversation.

The user wants to send a WhatsApp message. Extract the following:
1. to: The phone number to send to (E.164 format, e.g., +14155552671)
2. text: The message text to send

{{recentMessages}}

Based on the conversation, extract the message parameters.

Respond with a JSON object:
{
  "to": "+14155552671",
  "text": "Hello from WhatsApp!"
}
`;

interface SendMessageParams {
  to: string;
  text: string;
}

export const sendMessageAction: Action = {
  name: WHATSAPP_SEND_MESSAGE_ACTION,
  similes: ["SEND_WHATSAPP", "WHATSAPP_MESSAGE", "TEXT_WHATSAPP", "SEND_WHATSAPP_MESSAGE"],
  description: "Send a text message via WhatsApp",

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

    // Extract message parameters using LLM
    const prompt = composePromptFromState({
      state: currentState,
      template: SEND_MESSAGE_TEMPLATE,
    });

    let params: SendMessageParams;
    try {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseJSONObjectFromText(response) as unknown as SendMessageParams | null;
      if (!parsed || !parsed.to || !parsed.text) {
        // Try to use context from message
        const to = message.content?.from as string;
        const text = currentState.values?.response?.toString() || "";

        if (!to) {
          if (callback) {
            await callback({
              text: "Could not determine who to send the message to",
            });
          }
          return { success: false, error: "Missing recipient" };
        }

        // Validate text is not empty
        if (!text || text.trim() === "") {
          if (callback) {
            await callback({
              text: "Cannot send an empty message. Please provide message content.",
            });
          }
          return { success: false, error: "Empty message text" };
        }

        params = { to, text };
      } else {
        // Also validate that parsed text is not empty
        if (!parsed.text.trim()) {
          if (callback) {
            await callback({
              text: "Cannot send an empty message. Please provide message content.",
            });
          }
          return { success: false, error: "Empty message text" };
        }
        params = parsed;
      }
    } catch {
      if (callback) {
        await callback({
          text: "Failed to parse message parameters",
        });
      }
      return { success: false, error: "Failed to parse message parameters" };
    }

    // Send the message via WhatsApp Cloud API
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
          to: params.to,
          type: "text",
          text: {
            preview_url: false,
            body: params.text,
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || `HTTP ${response.status}`);
      }

      const data = (await response.json()) as { messages: Array<{ id: string }> };
      const messageId = data.messages?.[0]?.id;

      if (callback) {
        await callback({
          text: `Message sent to ${params.to}`,
          action: WHATSAPP_SEND_MESSAGE_ACTION,
        });
      }

      return {
        success: true,
        data: {
          action: WHATSAPP_SEND_MESSAGE_ACTION,
          to: params.to,
          messageId,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (callback) {
        await callback({
          text: `Failed to send WhatsApp message: ${errorMessage}`,
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
          text: "Send a WhatsApp message to +14155552671 saying hello",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send that WhatsApp message now.",
          actions: [WHATSAPP_SEND_MESSAGE_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
