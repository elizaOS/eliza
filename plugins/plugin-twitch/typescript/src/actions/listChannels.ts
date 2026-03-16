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

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return message.content.source === "twitch";
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
