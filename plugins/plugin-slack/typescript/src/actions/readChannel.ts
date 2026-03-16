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

const readChannelTemplate = `You are helping to extract read channel parameters for Slack.

The user wants to read message history from a Slack channel.

Recent conversation:
{{recentMessages}}

Extract the following:
1. channelRef: The channel to read from (default: "current" for the current channel, or a channel name/ID)
2. limit: Number of messages to retrieve (default: 10, max: 100)
3. before: Optional message timestamp to fetch messages before
4. after: Optional message timestamp to fetch messages after

Respond with a JSON object like:
{
  "channelRef": "current",
  "limit": 10,
  "before": null,
  "after": null
}

Only respond with the JSON object, no other text.`;

export const readChannel: Action = {
  name: "SLACK_READ_CHANNEL",
  similes: [
    "READ_SLACK_MESSAGES",
    "GET_CHANNEL_HISTORY",
    "SLACK_HISTORY",
    "FETCH_MESSAGES",
    "LIST_MESSAGES",
  ],
  description: "Read message history from a Slack channel",
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
    const slackService = runtime.getService(SLACK_SERVICE_NAME) as SlackService;

    if (!slackService || !slackService.client) {
      await callback?.({
        text: "Slack service is not available.",
        source: "slack",
      });
      return { success: false, error: "Slack service not available" };
    }

    const prompt = composePromptFromState({
      state,
      template: readChannelTemplate,
    });

    let readInfo: {
      channelRef?: string;
      limit?: number;
      before?: string | null;
      after?: string | null;
    } | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse = parseJSONObjectFromText(response);
      if (parsedResponse) {
        readInfo = {
          channelRef: parsedResponse.channelRef
            ? String(parsedResponse.channelRef)
            : "current",
          limit: parsedResponse.limit
            ? Math.min(Number(parsedResponse.limit), 100)
            : 10,
          before: parsedResponse.before
            ? String(parsedResponse.before)
            : undefined,
          after: parsedResponse.after
            ? String(parsedResponse.after)
            : undefined,
        };
        break;
      }
    }

    if (!readInfo) {
      readInfo = { channelRef: "current", limit: 10 };
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
    if (readInfo.channelRef && readInfo.channelRef !== "current") {
      const channels = await slackService.listChannels();
      const targetChannel = channels.find((ch) => {
        const channelName = ch.name?.toLowerCase() || "";
        const searchTerm = readInfo?.channelRef?.toLowerCase() || "";
        return (
          channelName === searchTerm ||
          channelName === searchTerm.replace(/^#/, "") ||
          ch.id === readInfo?.channelRef
        );
      });
      if (targetChannel) {
        targetChannelId = targetChannel.id;
      }
    }

    const messages = await slackService.readHistory(targetChannelId, {
      limit: readInfo.limit,
      before: readInfo.before || undefined,
      after: readInfo.after || undefined,
    });

    // Format messages for display
    const formattedMessages = messages.map((msg) => {
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const user = msg.user || "unknown";
      const text = msg.text || "[no text]";
      return `[${timestamp}] ${user}: ${text}`;
    });

    const channelInfo = await slackService.getChannel(targetChannelId);
    const channelName = channelInfo?.name || targetChannelId;

    const response: Content = {
      text: `Here are the last ${messages.length} messages from #${channelName}:\n\n${formattedMessages.join("\n")}`,
      source: message.content.source,
    };

    runtime.logger.debug(
      {
        src: "plugin:slack:action:read-channel",
        channelId: targetChannelId,
        messageCount: messages.length,
      },
      "[SLACK_READ_CHANNEL] Channel history retrieved",
    );

    await callback?.(response);

    return {
      success: true,
      data: {
        channelId: targetChannelId,
        channelName,
        messageCount: messages.length,
        messages: messages.map((m) => ({
          ts: m.ts,
          user: m.user,
          text: m.text,
          threadTs: m.threadTs,
        })),
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show me the last 5 messages in this channel",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll fetch the recent messages for you.",
          actions: ["SLACK_READ_CHANNEL"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "What's been happening in #announcements?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Let me check the recent messages in #announcements.",
          actions: ["SLACK_READ_CHANNEL"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default readChannel;
