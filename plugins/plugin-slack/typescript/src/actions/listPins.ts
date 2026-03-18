import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  composePromptFromState,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import type { SlackService } from "../service";
import { SLACK_SERVICE_NAME } from "../types";

const listPinsTemplate = `You are helping to extract list pins parameters for Slack.

The user wants to see pinned messages in a Slack channel.

Recent conversation:
{{recentMessages}}

Extract the following:
1. channelRef: The channel to list pins from (default: "current" for the current channel, or a channel name/ID)

Respond with a JSON object like:
{
  "channelRef": "current"
}

Only respond with the JSON object, no other text.`;

export const listPins: Action = {
  name: "SLACK_LIST_PINS",
  similes: [
    "LIST_SLACK_PINS",
    "SHOW_PINS",
    "GET_PINNED_MESSAGES",
    "PINNED_MESSAGES",
  ],
  description: "List pinned messages in a Slack channel",
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return message.content.source === "slack";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const slackService = await runtime.getService(SLACK_SERVICE_NAME) as SlackService;

    if (!slackService || !slackService.client) {
      await callback?.({
        text: "Slack service is not available.",
        source: "slack",
      });
      return { success: false, error: "Slack service not available" };
    }

    const prompt = composePromptFromState({
      state,
      template: listPinsTemplate,
    });

    let listInfo: { channelRef?: string } | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse = parseJSONObjectFromText(response);
      if (parsedResponse) {
        listInfo = {
          channelRef: parsedResponse.channelRef
            ? String(parsedResponse.channelRef)
            : "current",
        };
        break;
      }
    }

    if (!listInfo) {
      listInfo = { channelRef: "current" };
    }

    const stateData = state?.data;
    const room = stateData?.room || (await runtime.getRoom(message.roomId));

    if (!room || !room.channelId) {
      await callback?.({
        text: "I couldn't determine the current channel.",
        source: "slack",
      });
      return { success: false, error: "Could not determine channel" };
    }

    let targetChannelId = room.channelId;

    // If a specific channel was referenced (not "current"), try to find it
    if (listInfo.channelRef && listInfo.channelRef !== "current") {
      const channels = await slackService.listChannels();
      const targetChannel = channels.find((ch) => {
        const channelName = ch.name?.toLowerCase() || "";
        const searchTerm = listInfo?.channelRef?.toLowerCase() || "";
        return (
          channelName === searchTerm ||
          channelName === searchTerm.replace(/^#/, "") ||
          ch.id === listInfo?.channelRef
        );
      });
      if (targetChannel) {
        targetChannelId = targetChannel.id;
      }
    }

    const pins = await slackService.listPins(targetChannelId);

    if (pins.length === 0) {
      const channelInfo = await slackService.getChannel(targetChannelId);
      const channelName = channelInfo?.name || targetChannelId;

      const response: Content = {
        text: `There are no pinned messages in #${channelName}.`,
        source: message.content.source,
      };
      await callback?.(response);

      return {
        success: true,
        data: {
          channelId: targetChannelId,
          pinCount: 0,
          pins: [],
        },
      };
    }

    // Format pinned messages
    const formattedPins = pins.map((pin, index) => {
      const timestamp = new Date(parseFloat(pin.ts) * 1000).toISOString();
      const user = pin.user || "unknown";
      const text = pin.text?.slice(0, 100) || "[no text]";
      const truncated = pin.text && pin.text.length > 100 ? "..." : "";
      return `${index + 1}. [${timestamp}] ${user}: ${text}${truncated}`;
    });

    const channelInfo = await slackService.getChannel(targetChannelId);
    const channelName = channelInfo?.name || targetChannelId;

    const response: Content = {
      text: `Pinned messages in #${channelName} (${pins.length}):\n\n${formattedPins.join("\n\n")}`,
      source: message.content.source,
    };

    runtime.logger.debug(
      {
        src: "plugin:slack:action:list-pins",
        channelId: targetChannelId,
        pinCount: pins.length,
      },
      "[SLACK_LIST_PINS] Pins listed",
    );

    await callback?.(response);

    return {
      success: true,
      data: {
        channelId: targetChannelId,
        channelName,
        pinCount: pins.length,
        pins: pins.map((p) => ({
          ts: p.ts,
          user: p.user,
          text: p.text,
        })),
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show me the pinned messages in this channel",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll list the pinned messages.",
          actions: ["SLACK_LIST_PINS"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "What's pinned in #announcements?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Let me check the pins in #announcements.",
          actions: ["SLACK_LIST_PINS"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default listPins;
