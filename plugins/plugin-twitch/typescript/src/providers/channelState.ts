/**
 * Channel state provider for Twitch plugin.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { TwitchService } from "../service.js";
import {
  formatChannelForDisplay,
  normalizeChannel,
  TWITCH_SERVICE_NAME,
} from "../types.js";

/**
 * Provider that gives the agent information about the current Twitch channel context.
 */
export const channelStateProvider: Provider = {
  name: "twitchChannelState",
  description: "Provides information about the current Twitch channel context",

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult> => {
    // Only provide context for Twitch messages
    if (message.content.source !== "twitch") {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const twitchService =
      await runtime.getService<TwitchService>(TWITCH_SERVICE_NAME);

    if (!twitchService || !twitchService.isConnected()) {
      return {
        data: {
          connected: false,
        },
        values: {
          connected: false,
        },
        text: "",
      };
    }

    const agentName = state?.agentName || "The agent";

    // Get room from state if available
    const room = state?.data?.room;
    const channelId = room?.channelId as string | undefined;
    const channel = channelId
      ? normalizeChannel(channelId)
      : twitchService.getPrimaryChannel();

    const joinedChannels = twitchService.getJoinedChannels();
    const isPrimaryChannel = channel === twitchService.getPrimaryChannel();
    const botUsername = twitchService.getBotUsername();

    let responseText = `${agentName} is currently in Twitch channel ${formatChannelForDisplay(channel)}.`;

    if (isPrimaryChannel) {
      responseText += " This is the primary channel.";
    }

    responseText += `\n\nTwitch is a live streaming platform. Chat messages are public and visible to all viewers.`;
    responseText += ` ${agentName} is logged in as @${botUsername}.`;
    responseText += ` Currently connected to ${joinedChannels.length} channel(s).`;

    return {
      data: {
        channel,
        displayChannel: formatChannelForDisplay(channel),
        isPrimaryChannel,
        botUsername,
        joinedChannels,
        channelCount: joinedChannels.length,
        connected: true,
      },
      values: {
        channel,
        displayChannel: formatChannelForDisplay(channel),
        isPrimaryChannel,
        botUsername,
        channelCount: joinedChannels.length,
      },
      text: responseText,
    };
  },
};
