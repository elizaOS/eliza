/**
 * Join channel action for Twitch plugin.
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

const JOIN_CHANNEL_TEMPLATE = `You are helping to extract a Twitch channel name.

The user wants to join a Twitch channel.

Recent conversation:
{{recentMessages}}

Extract the channel name to join (without the # prefix).

Respond with TOON only:
channel: channelname`;

export const joinChannel: Action = {
  name: "TWITCH_JOIN_CHANNEL",
  similes: ["JOIN_TWITCH_CHANNEL", "ENTER_CHANNEL", "CONNECT_CHANNEL"],
  description: "Join a Twitch channel to listen and send messages",
  descriptionCompressed: "join Twitch channel listen send message",

  validate: async (
    runtime: any,
    message: any,
    state?: any,
    options?: any,
  ): Promise<boolean> => {
    const __avTextRaw =
      typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["twitch", "join", "channel"];
    const __avKeywordOk =
      (__avKeywords.length > 0 &&
        __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw))) ||
      String(message?.content?.source ?? "") === "twitch";
    const __avRegex = new RegExp("\\b(?:twitch|join|channel)\\b", "i");
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

    // Compose prompt
    const currentState = state ?? (await runtime.composeState(message));
    const prompt = await composePromptFromState({
      template: JOIN_CHANNEL_TEMPLATE,
      state: currentState,
    });

    // Extract channel name using LLM
    let channelName: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseToonKeyValue<Record<string, unknown>>(
        String(response),
      );
      if (parsed?.channel) {
        channelName = normalizeChannel(String(parsed.channel));
        break;
      }
    }

    if (!channelName) {
      if (callback) {
        callback({
          text: "I couldn't understand which channel you want me to join. Please specify the channel name.",
          source: "twitch",
        });
      }
      return { success: false, error: "Could not extract channel name" };
    }

    // Check if already joined
    if (twitchService.getJoinedChannels().includes(channelName)) {
      if (callback) {
        callback({
          text: `Already in channel #${channelName}.`,
          source: "twitch",
        });
      }
      return {
        success: true,
        data: { channel: channelName, alreadyJoined: true },
      };
    }

    // Join channel
    await twitchService.joinChannel(channelName);

    if (callback) {
      callback({
        text: `Joined channel #${channelName}.`,
        source: message.content.source as string,
      });
    }

    return {
      success: true,
      data: {
        channel: channelName,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Join the channel shroud" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll join that channel.",
          actions: ["TWITCH_JOIN_CHANNEL"],
        },
      },
    ],
  ],
};
