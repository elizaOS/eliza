/**
 * Send message action for Google Chat plugin.
 */

import {
  type Action,
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import type { GoogleChatService } from "../service.js";
import {
  GOOGLE_CHAT_SERVICE_NAME,
  normalizeSpaceTarget,
  splitMessageForGoogleChat,
} from "../types.js";

interface SendMessageParams {
  text: string;
  space: string;
  thread?: string;
}

const SEND_MESSAGE_TEMPLATE = `# Task: Extract Google Chat send message parameters
Based on the conversation, determine what message to send and to which space.

Recent conversation:
{{recentMessages}}

Extract the following:
- text: The message content to send
- space: The target space ID (or "current" for the current space)
- thread: Optional thread name to reply in

Respond with a JSON object:
\`\`\`json
{
  "text": "message content here",
  "space": "spaces/xxx or current",
  "thread": "optional thread name"
}
\`\`\``;

export const sendMessage: Action = {
  name: "GOOGLE_CHAT_SEND_MESSAGE",
  similes: [
    "SEND_GOOGLE_CHAT_MESSAGE",
    "MESSAGE_GOOGLE_CHAT",
    "GCHAT_SEND",
    "GOOGLE_CHAT_TEXT",
  ],
  description: "Send a message to a Google Chat space",

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
    const gchatService = await runtime.getService<GoogleChatService>(
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
      template: SEND_MESSAGE_TEMPLATE,
      state: currentState,
    });

    // Extract parameters using LLM
    let messageInfo: SendMessageParams | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseJSONObjectFromText(response);
      if (parsed?.text) {
        messageInfo = {
          text: String(parsed.text),
          space: String(parsed.space || "current"),
          thread: parsed.thread ? String(parsed.thread) : undefined,
        };
        break;
      }
    }

    if (!messageInfo || !messageInfo.text) {
      if (callback) {
        callback({
          text: "I couldn't understand what message you want me to send. Please try again.",
          source: "google-chat",
        });
      }
      return { success: false, error: "Could not extract message parameters" };
    }

    // Determine target space
    let targetSpace: string | undefined;
    if (messageInfo.space && messageInfo.space !== "current") {
      const normalized = normalizeSpaceTarget(messageInfo.space);
      if (normalized) {
        targetSpace = normalized;
      }
    }

    // Get space from state context if available
    const spaceData = currentState.data?.space as
      | Record<string, unknown>
      | undefined;
    if (!targetSpace && spaceData?.name) {
      targetSpace = String(spaceData.name);
    }

    if (!targetSpace) {
      if (callback) {
        callback({
          text: "I couldn't determine which space to send to. Please specify a space.",
          source: "google-chat",
        });
      }
      return { success: false, error: "Could not determine target space" };
    }

    // Split message if too long
    const chunks = splitMessageForGoogleChat(messageInfo.text);

    // Send message(s)
    let lastResult: { messageName?: string } | undefined;
    for (const chunk of chunks) {
      const result = await gchatService.sendMessage({
        space: targetSpace,
        text: chunk,
        thread: messageInfo.thread,
      });

      if (!result.success) {
        if (callback) {
          callback({
            text: `Failed to send message: ${result.error}`,
            source: "google-chat",
          });
        }
        return { success: false, error: result.error };
      }

      lastResult = { messageName: result.messageName };
      logger.debug(`Sent Google Chat message: ${result.messageName}`);
    }

    if (callback) {
      callback({
        text: "Message sent successfully.",
        source: message.content.source as string,
      });
    }

    return {
      success: true,
      data: {
        space: targetSpace,
        messageName: lastResult?.messageName,
        chunksCount: chunks.length,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Send a message saying 'Hello everyone!'" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that message to the space.",
          actions: ["GOOGLE_CHAT_SEND_MESSAGE"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Post 'Meeting starts in 5 minutes' to the team space",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll post that reminder to the team space.",
          actions: ["GOOGLE_CHAT_SEND_MESSAGE"],
        },
      },
    ],
  ],
};
