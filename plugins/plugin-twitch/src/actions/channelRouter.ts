/**
 * Router action for Twitch channel management.
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
import {
  formatChannelForDisplay,
  normalizeChannel,
  TWITCH_SERVICE_NAME,
} from "../types.js";

type TwitchChannelSubaction = "join" | "leave" | "list";

const CHANNEL_TEMPLATE = `You are helping to extract Twitch channel management parameters.

Recent conversation:
{{recentMessages}}

Extract:
subaction: join, leave, or list
channel: channel name without #, or empty for list

Respond with TOON only:
subaction: list
channel:`;

function readStringOption(
  options: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = options?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSubaction(
  value: string | null,
): TwitchChannelSubaction | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "join" ||
    normalized === "leave" ||
    normalized === "list"
  ) {
    return normalized;
  }
  return null;
}

function inferSubaction(text: string): TwitchChannelSubaction | null {
  const normalized = text.toLowerCase();
  if (/\b(join|enter|connect)\b/.test(normalized)) return "join";
  if (/\b(leave|part|exit|disconnect)\b/.test(normalized)) return "leave";
  if (/\b(list|show|get|current)\b/.test(normalized)) return "list";
  return null;
}

async function extractChannelParams(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
): Promise<{
  subaction: TwitchChannelSubaction;
  channel: string | null;
} | null> {
  const currentState = state ?? (await runtime.composeState(message));
  const prompt = await composePromptFromState({
    template: CHANNEL_TEMPLATE,
    state: currentState,
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const parsed = parseToonKeyValue<Record<string, unknown>>(String(response));
    const subaction = normalizeSubaction(
      parsed?.subaction ? String(parsed.subaction) : null,
    );
    if (subaction) {
      return {
        subaction,
        channel: parsed?.channel
          ? normalizeChannel(String(parsed.channel))
          : null,
      };
    }
  }

  return null;
}

function listChannelsResult(
  twitchService: TwitchService,
  source: string,
  callback?: (response: { text: string; source?: string }) => void,
): ActionResult {
  const joinedChannels = twitchService.getJoinedChannels();
  const primaryChannel = twitchService.getPrimaryChannel();
  const channelList = joinedChannels.map((channel) => {
    const displayName = formatChannelForDisplay(channel);
    return channel === primaryChannel
      ? `${displayName} (primary)`
      : displayName;
  });

  const text =
    joinedChannels.length > 0
      ? `Currently in ${joinedChannels.length} channel(s):\n${channelList
          .map((channel) => `- ${channel}`)
          .join("\n")}`
      : "Not currently in any channels.";

  callback?.({ text, source });
  return {
    success: true,
    data: {
      subaction: "list",
      channelCount: joinedChannels.length,
      channels: joinedChannels,
      primaryChannel,
    },
  };
}

export const twitchChannelAction: Action = {
  name: "TWITCH_CHANNEL",
  similes: [
    "TWITCH_JOIN_CHANNEL",
    "TWITCH_LEAVE_CHANNEL",
    "TWITCH_LIST_CHANNELS",
    "MANAGE_TWITCH_CHANNEL",
  ],
  description:
    "Manage Twitch channel membership with subaction join, leave, or list.",
  descriptionCompressed:
    "manage Twitch channel membership; subaction join leave list",
  parameters: [
    {
      name: "subaction",
      description: "One of join, leave, or list.",
      required: true,
      schema: { type: "string", enum: ["join", "leave", "list"] },
    },
    {
      name: "channel",
      description: "Twitch channel name without # for join/leave.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      message.content.source === "twitch" &&
      /\b(twitch|channel|join|leave|list|channels)\b/.test(text) &&
      !/\b(send|say|message)\b/.test(text)
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: (response: { text: string; source?: string }) => void,
  ): Promise<ActionResult> => {
    const twitchService =
      runtime.getService<TwitchService>(TWITCH_SERVICE_NAME);

    if (!twitchService || !twitchService.isConnected()) {
      callback?.({
        text: "Twitch service is not available.",
        source: "twitch",
      });
      return { success: false, error: "Twitch service not available" };
    }

    const optionSubaction = normalizeSubaction(
      readStringOption(options, "subaction"),
    );
    const optionChannel = readStringOption(options, "channel");
    const inferredSubaction = inferSubaction(message.content.text ?? "");
    const extracted =
      optionSubaction && (optionChannel || optionSubaction === "list")
        ? null
        : await extractChannelParams(runtime, message, state);

    const subaction =
      optionSubaction ?? inferredSubaction ?? extracted?.subaction;
    const channel = optionChannel
      ? normalizeChannel(optionChannel)
      : extracted?.channel
        ? normalizeChannel(extracted.channel)
        : null;

    if (subaction === "list") {
      return listChannelsResult(
        twitchService,
        String(message.content.source ?? "twitch"),
        callback,
      );
    }

    if (!subaction) {
      callback?.({
        text: "I couldn't determine whether to join, leave, or list Twitch channels.",
        source: "twitch",
      });
      return { success: false, error: "Missing subaction" };
    }

    if (!channel) {
      callback?.({
        text: "Please specify the Twitch channel.",
        source: "twitch",
      });
      return { success: false, error: "Missing channel" };
    }

    if (subaction === "join") {
      if (twitchService.getJoinedChannels().includes(channel)) {
        callback?.({
          text: `Already in channel #${channel}.`,
          source: "twitch",
        });
        return {
          success: true,
          data: { subaction, channel, alreadyJoined: true },
        };
      }

      await twitchService.joinChannel(channel);
      callback?.({
        text: `Joined channel #${channel}.`,
        source: String(message.content.source ?? "twitch"),
      });
      return { success: true, data: { subaction, channel } };
    }

    const joinedChannels = twitchService.getJoinedChannels();
    if (!joinedChannels.includes(channel)) {
      callback?.({
        text: `Not currently in channel #${channel}.`,
        source: "twitch",
      });
      return { success: false, error: "Not in that channel" };
    }

    if (channel === twitchService.getPrimaryChannel()) {
      callback?.({
        text: `Cannot leave the primary channel #${channel}.`,
        source: "twitch",
      });
      return { success: false, error: "Cannot leave primary channel" };
    }

    await twitchService.leaveChannel(channel);
    callback?.({
      text: `Left channel #${channel}.`,
      source: String(message.content.source ?? "twitch"),
    });
    return { success: true, data: { subaction, channel } };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Join the Twitch channel shroud" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll join that channel.",
          actions: ["TWITCH_CHANNEL"],
        },
      },
    ],
  ],
};
