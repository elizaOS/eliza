/**
 * Provider that exposes the list of Twitch channels the bot is in.
 *
 * Replaces the previous TWITCH_LIST_CHANNELS action — listing is read-only
 * state and belongs in the provider layer.
 */

import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import type { TwitchService } from "../service.js";
import { TWITCH_SERVICE_NAME } from "../types.js";

function providerText(value: unknown): string {
  return JSON.stringify({ twitch_channels: value }, null, 2);
}
const CHANNEL_LIMIT = 50;

export const twitchChannelsProvider: Provider = {
  name: "twitchChannels",
  description: "Twitch channels the bot is currently joined to.",
  descriptionCompressed: "Twitch joined channels list.",
  dynamic: true,
  contexts: ["social", "connectors"],
  contextGate: { anyOf: ["social", "connectors"] },
  cacheStable: false,
  cacheScope: "turn",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const twitchService =
      runtime.getService<TwitchService>(TWITCH_SERVICE_NAME);

    if (!twitchService || !twitchService.isConnected()) {
      return { text: providerText({ status: "not_connected" }) };
    }

    try {
      const joinedChannels = twitchService.getJoinedChannels();
      const primaryChannel = twitchService.getPrimaryChannel();
      const channels = joinedChannels.slice(0, CHANNEL_LIMIT);

      return {
        text: providerText({
          status: "ready",
          count: channels.length,
          primaryChannel,
          channels: channels.map((channel) => ({
            name: channel,
            primary: channel === primaryChannel,
          })),
        }),
        data: {
          channelCount: channels.length,
          channels,
          primaryChannel,
        },
      };
    } catch (error) {
      return {
        text: providerText({ status: "error" }),
        data: {
          channelCount: 0,
          channels: [],
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};
