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
import {
  composePromptFromState,
  ModelType,
  parseJSONObjectFromText,
} from "@elizaos/core";
import type { TwitchService } from "../service.js";
import { normalizeChannel, TWITCH_SERVICE_NAME } from "../types.js";

const JOIN_CHANNEL_TEMPLATE = `You are helping to extract a Twitch channel name.

The user wants to join a Twitch channel.

Recent conversation:
{{recentMessages}}

Extract the channel name to join (without the # prefix).

Respond with a JSON object like:
{
  "channel": "channelname"
}

Only respond with the JSON object, no other text.`;

export const joinChannel: Action = {
  name: "TWITCH_JOIN_CHANNEL",
  similes: ["JOIN_TWITCH_CHANNEL", "ENTER_CHANNEL", "CONNECT_CHANNEL"],
  description: "Join a Twitch channel to listen and send messages",

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

      const parsed = parseJSONObjectFromText(String(response));
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
