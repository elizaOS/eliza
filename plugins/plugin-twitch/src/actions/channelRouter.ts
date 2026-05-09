/**
 * Router action for Twitch channel join/leave ops.
 *
 * Listing joined channels lives on the `twitchChannels` provider.
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

type TwitchChannelOp = "join" | "leave";

const MAX_TWITCH_CHANNEL_NAME_CHARS = 80;
const TWITCH_CHANNEL_ACTION_TIMEOUT_MS = 30_000;

const CHANNEL_TEMPLATE = `You are helping to extract Twitch channel join/leave parameters.

Recent conversation:
{{recentMessages}}

Extract:
op: join or leave
channel: channel name without #

Respond with JSON only, with no prose or fences:
{
  "op": "join",
  "channel": ""
}`;

function readStringOption(
  options: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = options?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeOp(value: string | null): TwitchChannelOp | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "join" || normalized === "leave") {
    return normalized;
  }
  return null;
}

function truncateActionText(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function inferOp(text: string): TwitchChannelOp | null {
  const normalized = text.toLowerCase();
  if (/\b(join|enter|connect)\b/.test(normalized)) return "join";
  if (/\b(leave|part|exit|disconnect)\b/.test(normalized)) return "leave";
  return null;
}

async function extractChannelParams(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
): Promise<{ op: TwitchChannelOp; channel: string | null } | null> {
  const currentState = state ?? (await runtime.composeState(message));
  const prompt = await composePromptFromState({
    template: CHANNEL_TEMPLATE,
    state: currentState,
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const parsed = parseJSONObjectFromText(String(response)) as Record<
      string,
      unknown
    > | null;
    const op = normalizeOp(parsed?.op ? String(parsed.op) : null);
    if (op) {
      return {
        op,
        channel: parsed?.channel
          ? normalizeChannel(String(parsed.channel))
          : null,
      };
    }
  }

  return null;
}

export const twitchChannelAction: Action = {
  name: "TWITCH_CHANNEL_OP",
  similes: [
    "TWITCH_CHANNEL",
    "TWITCH_JOIN_CHANNEL",
    "TWITCH_LEAVE_CHANNEL",
    "MANAGE_TWITCH_CHANNEL",
  ],
  description: "Join or leave a Twitch channel.",
  descriptionCompressed: "Twitch channel ops: join, leave.",
  contexts: ["messaging", "connectors"],
  contextGate: { anyOf: ["messaging", "connectors"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "op",
      description: "Either join or leave.",
      required: true,
      schema: { type: "string", enum: ["join", "leave"] },
    },
    {
      name: "channel",
      description: "Twitch channel name without #.",
      required: true,
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
      /\b(twitch|channel|join|leave)\b/.test(text) &&
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

    if (!twitchService?.isConnected()) {
      callback?.({
        text: "Twitch service is not available.",
        source: "twitch",
      });
      return { success: false, error: "Twitch service not available" };
    }

    const optionOp = normalizeOp(readStringOption(options, "op"));
    const optionChannel = readStringOption(options, "channel");
    const timeoutMs = TWITCH_CHANNEL_ACTION_TIMEOUT_MS;
    const inferredOp = inferOp(message.content.text ?? "");
    const extracted =
      optionOp && optionChannel
        ? null
        : await extractChannelParams(runtime, message, state);

    const op = optionOp ?? inferredOp ?? extracted?.op ?? null;
    const channel = optionChannel
      ? normalizeChannel(
          truncateActionText(optionChannel, MAX_TWITCH_CHANNEL_NAME_CHARS),
        )
      : extracted?.channel
        ? normalizeChannel(
            truncateActionText(
              extracted.channel,
              MAX_TWITCH_CHANNEL_NAME_CHARS,
            ),
          )
        : null;

    if (!op) {
      callback?.({
        text: "I couldn't determine whether to join or leave the Twitch channel.",
        source: "twitch",
      });
      return { success: false, error: "Missing op" };
    }

    if (!channel) {
      callback?.({
        text: "Please specify the Twitch channel.",
        source: "twitch",
      });
      return { success: false, error: "Missing channel" };
    }

    if (op === "join") {
      if (twitchService.getJoinedChannels().includes(channel)) {
        callback?.({
          text: `Already in channel #${channel}.`,
          source: "twitch",
        });
        return {
          success: true,
          data: { op, channel, alreadyJoined: true, timeoutMs },
        };
      }

      await twitchService.joinChannel(channel);
      callback?.({
        text: `Joined channel #${channel}.`,
        source: String(message.content.source ?? "twitch"),
      });
      return { success: true, data: { op, channel, timeoutMs } };
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
    return { success: true, data: { op, channel, timeoutMs } };
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
          actions: ["TWITCH_CHANNEL_OP"],
        },
      },
    ],
  ],
};
