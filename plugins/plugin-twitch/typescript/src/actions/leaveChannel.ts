/**
 * Leave channel action for Twitch plugin.
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

const LEAVE_CHANNEL_TEMPLATE = `You are helping to extract a Twitch channel name.

The user wants to leave a Twitch channel.

Recent conversation:
{{recentMessages}}

Currently joined channels: {{joinedChannels}}

Extract the channel name to leave (without the # prefix).

Respond with a JSON object like:
{
  "channel": "channelname"
}

Only respond with the JSON object, no other text.`;

export const leaveChannel: Action = {
  name: "TWITCH_LEAVE_CHANNEL",
  similes: [
    "LEAVE_TWITCH_CHANNEL",
    "EXIT_CHANNEL",
    "PART_CHANNEL",
    "DISCONNECT_CHANNEL",
  ],
  description: "Leave a Twitch channel",

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
      await runtime.getService<TwitchService>(TWITCH_SERVICE_NAME);

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

    // Get or compose state
    const currentState = state ?? (await runtime.composeState(message));

    // Build state with joined channels
    const enrichedState = {
      ...currentState,
      joinedChannels: joinedChannels.join(", "),
    };

    // Compose prompt
    const prompt = await composePromptFromState({
      template: LEAVE_CHANNEL_TEMPLATE,
      state: enrichedState,
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
          text: "I couldn't understand which channel you want me to leave. Please specify the channel name.",
          source: "twitch",
        });
      }
      return { success: false, error: "Could not extract channel name" };
    }

    // Check if we're in that channel
    if (!joinedChannels.includes(channelName)) {
      if (callback) {
        callback({
          text: `Not currently in channel #${channelName}.`,
          source: "twitch",
        });
      }
      return { success: false, error: "Not in that channel" };
    }

    // Prevent leaving primary channel
    if (channelName === twitchService.getPrimaryChannel()) {
      if (callback) {
        callback({
          text: `Cannot leave the primary channel #${channelName}.`,
          source: "twitch",
        });
      }
      return { success: false, error: "Cannot leave primary channel" };
    }

    // Leave channel
    await twitchService.leaveChannel(channelName);

    if (callback) {
      callback({
        text: `Left channel #${channelName}.`,
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
        content: { text: "Leave the channel shroud" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll leave that channel.",
          actions: ["TWITCH_LEAVE_CHANNEL"],
        },
      },
    ],
  ],
};
