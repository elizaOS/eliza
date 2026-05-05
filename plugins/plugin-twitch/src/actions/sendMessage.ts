/**
 * Send message action for Twitch plugin.
 */

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { composePromptFromState, ModelType } from "@elizaos/core";
import type { TwitchService } from "../service.js";
import { parseToonKeyValue } from "../toon.js";
import { normalizeChannel, TWITCH_SERVICE_NAME } from "../types.js";

const SEND_MESSAGE_TEMPLATE = `You are helping to extract send message parameters for Twitch chat.

The user wants to send a message to a Twitch channel.

Recent conversation:
{{recentMessages}}

Extract the following:
1. text: The message text to send
2. channel: The channel name to send to (without # prefix), or "current" for the current channel

Respond with TOON only:
text: The message to send
channel: current`;

interface SendMessageParams {
  text: string;
  channel: string;
}

export const sendMessage: Action = {
  name: "TWITCH_SEND_MESSAGE",
  similes: [
    "SEND_TWITCH_MESSAGE",
    "TWITCH_CHAT",
    "CHAT_TWITCH",
    "SAY_IN_TWITCH",
  ],
  description: "Send a message to a Twitch channel",
  descriptionCompressed: "send message Twitch channel",

  validate: async (
    runtime: any,
    message: any,
    state?: any,
    options?: any,
  ): Promise<boolean> => {
    const __avTextRaw =
      typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["twitch", "send", "message"];
    const __avKeywordOk =
      (__avKeywords.length > 0 &&
        __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw))) ||
      String(message?.content?.source ?? "") === "twitch";
    const __avRegex = new RegExp("\\b(?:twitch|send|message)\\b", "i");
    const __avRegexOk =
      __avRegex.test(__avText) ||
      String(message?.content?.source ?? "") === "twitch";
    const __avSource = String(message?.content?.source ?? "");
    const __avExpectedSource = "twitch";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object") ||
      String(message?.content?.source ?? "") === "twitch";

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
    ): Promise<boolean> => {
      return message.content.source === "twitch";
    };
    try {
      return Boolean(
        await (__avLegacyValidate as any)(runtime, message, state, options),
      );
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: (response: { text: string; source?: string }) => void,
  ): Promise<ActionResult> => {
    const twitchService =
      runtime.getService<TwitchService>(TWITCH_SERVICE_NAME);

    if (!twitchService || !twitchService.isConnected()) {
      if (callback) {
        callback({
          text: "Twitch service is not available.",
          source: "twitch",
        });
      }
      return { success: false, error: "Twitch service not available" };
    }

    // Get or compose state
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

      const parsed = parseToonKeyValue<Record<string, unknown>>(
        String(response),
      );
      if (parsed?.text) {
        messageInfo = {
          text: String(parsed.text),
          channel: String(parsed.channel || "current"),
        };
        break;
      }
    }

    if (!messageInfo || !messageInfo.text) {
      if (callback) {
        callback({
          text: "I couldn't understand what message you want me to send. Please try again.",
          source: "twitch",
        });
      }
      return { success: false, error: "Could not extract message parameters" };
    }

    // Determine target channel
    let targetChannel = twitchService.getPrimaryChannel();
    if (messageInfo.channel && messageInfo.channel !== "current") {
      targetChannel = normalizeChannel(messageInfo.channel);
    }

    // Get channel from room context if available
    if (currentState?.data?.room?.channelId) {
      targetChannel = normalizeChannel(
        currentState.data.room.channelId as string,
      );
    }

    // Send message
    const result = await twitchService.sendMessage(messageInfo.text, {
      channel: targetChannel,
    });

    if (!result.success) {
      if (callback) {
        callback({
          text: `Failed to send message: ${result.error}`,
          source: "twitch",
        });
      }
      return { success: false, error: result.error };
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
        channel: targetChannel,
        messageId: result.messageId,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Send a message to chat saying 'Hello everyone!'" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that message to the chat.",
          actions: ["TWITCH_SEND_MESSAGE"],
        },
      },
    ],
  ],
};
