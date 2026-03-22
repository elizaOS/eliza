/**
 * Send message action for the iMessage plugin.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  composePromptFromState,
  logger,
  ModelType,
  parseJSONObjectFromText,
} from "@elizaos/core";
import type { IMessageService } from "../service.js";
import {
  IMESSAGE_SERVICE_NAME,
  isValidIMessageTarget,
  normalizeIMessageTarget,
} from "../types.js";

const SEND_MESSAGE_TEMPLATE = `# Task: Extract iMessage parameters

Based on the conversation, determine what message to send and to whom.

Recent conversation:
{{recentMessages}}

Extract the following:
1. text: The message content to send
2. to: The recipient (phone number, email, or "current" to reply)

Respond with a JSON object:
\`\`\`json
{
  "text": "message to send",
  "to": "phone/email or 'current'"
}
\`\`\`
`;

interface SendMessageParams {
  text: string;
  to: string;
}

export const sendMessage: Action = {
  name: "IMESSAGE_SEND_MESSAGE",
  similes: ["SEND_IMESSAGE", "IMESSAGE_TEXT", "TEXT_IMESSAGE", "SEND_IMSG"],
  description: "Send a text message via iMessage (macOS only)",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return message.content.source === "imessage";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const imessageService = await runtime.getService<IMessageService>(
      IMESSAGE_SERVICE_NAME,
    );

    if (!imessageService || !imessageService.isConnected()) {
      if (callback) {
        callback({
          text: "iMessage service is not available.",
          source: "imessage",
        });
      }
      return { success: false, error: "iMessage service not available" };
    }

    if (!imessageService.isMacOS()) {
      if (callback) {
        callback({
          text: "iMessage is only available on macOS.",
          source: "imessage",
        });
      }
      return { success: false, error: "iMessage requires macOS" };
    }

    // Compose state if not provided
    const currentState = state ?? (await runtime.composeState(message));

    // Extract parameters using LLM
    const prompt = await composePromptFromState({
      template: SEND_MESSAGE_TEMPLATE,
      state: currentState,
    });

    let msgInfo: SendMessageParams | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseJSONObjectFromText(response);
      if (parsed?.text) {
        msgInfo = {
          text: String(parsed.text),
          to: String(parsed.to || "current"),
        };
        break;
      }
    }

    if (!msgInfo || !msgInfo.text) {
      if (callback) {
        callback({
          text: "I couldn't understand what message you want me to send. Please try again.",
          source: "imessage",
        });
      }
      return { success: false, error: "Could not extract message parameters" };
    }

    // Determine target
    let targetId: string | undefined;

    if (msgInfo.to && msgInfo.to !== "current") {
      const normalized = normalizeIMessageTarget(msgInfo.to);
      if (normalized && isValidIMessageTarget(normalized)) {
        targetId = normalized;
      }
    }

    // Fall back to current chat
    if (!targetId) {
      const stateData = (currentState.data || {}) as Record<string, unknown>;
      targetId = (stateData.chatId as string) || (stateData.handle as string);
    }

    if (!targetId) {
      if (callback) {
        callback({
          text: "I couldn't determine who to send the message to. Please specify a phone number or email.",
          source: "imessage",
        });
      }
      return { success: false, error: "Could not determine recipient" };
    }

    // Send message
    const result = await imessageService.sendMessage(targetId, msgInfo.text);

    if (!result.success) {
      if (callback) {
        callback({
          text: `Failed to send message: ${result.error}`,
          source: "imessage",
        });
      }
      return { success: false, error: result.error };
    }

    logger.debug(`Sent iMessage to ${targetId}`);

    if (callback) {
      callback({
        text: "Message sent successfully.",
        source: message.content.source as string,
      });
    }

    return {
      success: true,
      data: {
        to: targetId,
        messageId: result.messageId,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Send them a message saying 'Hello!'" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that message via iMessage.",
          actions: ["IMESSAGE_SEND_MESSAGE"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Text +1234567890 saying 'I'll be there in 10 minutes'",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that text.",
          actions: ["IMESSAGE_SEND_MESSAGE"],
        },
      },
    ],
  ],
};
