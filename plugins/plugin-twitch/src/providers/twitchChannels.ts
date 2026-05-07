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

export const twitchChannelsProvider: Provider = {
  name: "twitchChannels",
  description: "Twitch channels the bot is currently joined to.",
  descriptionCompressed: "Twitch joined channels list.",
  dynamic: true,
  contexts: ["social", "connectors"],
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

    const joinedChannels = twitchService.getJoinedChannels();
    const primaryChannel = twitchService.getPrimaryChannel();

    return {
      text: providerText({
        status: "ready",
        count: joinedChannels.length,
        primaryChannel,
        channels: joinedChannels.map((channel) => ({
          name: channel,
          primary: channel === primaryChannel,
        })),
      }),
      data: {
        channelCount: joinedChannels.length,
        channels: joinedChannels,
        primaryChannel,
      },
    };
  },
};
