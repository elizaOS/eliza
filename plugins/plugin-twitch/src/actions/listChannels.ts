/**
 * List channels action for Twitch plugin.
 */

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { TwitchService } from "../service.js";
import { formatChannelForDisplay, TWITCH_SERVICE_NAME } from "../types.js";

export const listChannels: Action = {
  name: "TWITCH_LIST_CHANNELS",
  similes: [
    "LIST_TWITCH_CHANNELS",
    "SHOW_CHANNELS",
    "GET_CHANNELS",
    "CURRENT_CHANNELS",
  ],
  description: "List all Twitch channels the bot is currently in",
  descriptionCompressed: "list Twitch channel bot",

  validate: async (
    runtime: any,
    message: any,
    state?: any,
    options?: any,
  ): Promise<boolean> => {
    const __avTextRaw =
      typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["twitch", "list", "channels"];
    const __avKeywordOk =
      (__avKeywords.length > 0 &&
        __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw))) ||
      String(message?.content?.source ?? "") === "twitch";
    const __avRegex = new RegExp("\\b(?:twitch|list|channels)\\b", "i");
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
    _state?: State,
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

    const joinedChannels = twitchService.getJoinedChannels();
    const primaryChannel = twitchService.getPrimaryChannel();

    // Format channel list
    const channelList = joinedChannels.map((channel) => {
      const displayName = formatChannelForDisplay(channel);
      const isPrimary = channel === primaryChannel;
      return isPrimary ? `${displayName} (primary)` : displayName;
    });

    const responseText =
      joinedChannels.length > 0
        ? `Currently in ${joinedChannels.length} channel(s):\n${channelList.map((c) => `• ${c}`).join("\n")}`
        : "Not currently in any channels.";

    if (callback) {
      callback({
        text: responseText,
        source: message.content.source as string,
      });
    }

    return {
      success: true,
      data: {
        channelCount: joinedChannels.length,
        channels: joinedChannels,
        primaryChannel,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What channels are you in?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll list the channels I'm currently in.",
          actions: ["TWITCH_LIST_CHANNELS"],
        },
      },
    ],
  ],
};
