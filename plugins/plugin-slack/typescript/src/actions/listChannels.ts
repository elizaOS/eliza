import type {
  Action,
  ActionExample,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { SlackService } from "../service";
import { SLACK_SERVICE_NAME } from "../types";

export const listChannels: Action = {
  name: "SLACK_LIST_CHANNELS",
  similes: [
    "LIST_SLACK_CHANNELS",
    "SHOW_CHANNELS",
    "GET_CHANNELS",
    "CHANNELS_LIST",
  ],
  description: "List available Slack channels in the workspace",
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
    _state?: State,
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

    const channels = await slackService.listChannels({
      types: "public_channel,private_channel",
      limit: 100,
    });

    // Sort channels by name
    const sortedChannels = channels
      .filter((ch) => !ch.isArchived)
      .sort((a, b) => a.name.localeCompare(b.name));

    // Format channel list
    const channelList = sortedChannels.map((ch) => {
      const memberCount =
        ch.numMembers !== undefined ? ` (${ch.numMembers} members)` : "";
      const privateIndicator = ch.isPrivate ? " 🔒" : "";
      const topic = ch.topic?.value
        ? ` - ${ch.topic.value.slice(0, 50)}${ch.topic.value.length > 50 ? "..." : ""}`
        : "";
      return `• #${ch.name}${privateIndicator}${memberCount}${topic}`;
    });

    const response: Content = {
      text: `Found ${sortedChannels.length} channels:\n\n${channelList.join("\n")}`,
      source: message.content.source,
    };

    runtime.logger.debug(
      {
        src: "plugin:slack:action:list-channels",
        channelCount: sortedChannels.length,
      },
      "[SLACK_LIST_CHANNELS] Channels listed",
    );

    await callback?.(response);

    return {
      success: true,
      data: {
        channelCount: sortedChannels.length,
        channels: sortedChannels.map((ch) => ({
          id: ch.id,
          name: ch.name,
          isPrivate: ch.isPrivate,
          numMembers: ch.numMembers,
          topic: ch.topic?.value,
          purpose: ch.purpose?.value,
        })),
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show me all the channels in this workspace",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll list all the available channels.",
          actions: ["SLACK_LIST_CHANNELS"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "What channels can I join?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Let me show you the available channels.",
          actions: ["SLACK_LIST_CHANNELS"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default listChannels;
