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
import { isValidMessageTs, SLACK_SERVICE_NAME } from "../types";

const unpinMessageTemplate = `You are helping to extract unpin message parameters for Slack.

The user wants to unpin a message from a Slack channel.

Recent conversation:
{{recentMessages}}

Extract the following:
1. messageTs: The message timestamp to unpin (format: 1234567890.123456)
2. channelId: The channel ID (optional, defaults to current channel)

Respond with a JSON object like:
{
  "messageTs": "1234567890.123456",
  "channelId": null
}

Only respond with the JSON object, no other text.`;

export const unpinMessage: Action = {
  name: "SLACK_UNPIN_MESSAGE",
  similes: [
    "UNPIN_SLACK_MESSAGE",
    "UNPIN_MESSAGE",
    "SLACK_UNPIN",
    "REMOVE_PIN",
  ],
  description: "Unpin a message from a Slack channel",
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
      template: unpinMessageTemplate,
    });

    let unpinInfo: {
      messageTs: string;
      channelId?: string | null;
    } | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse = parseJSONObjectFromText(response);
      if (parsedResponse?.messageTs) {
        unpinInfo = {
          messageTs: String(parsedResponse.messageTs),
          channelId: parsedResponse.channelId
            ? String(parsedResponse.channelId)
            : null,
        };
        break;
      }
    }

    if (!unpinInfo || !unpinInfo.messageTs) {
      runtime.logger.debug(
        { src: "plugin:slack:action:unpin-message" },
        "[SLACK_UNPIN_MESSAGE] Could not extract unpin info",
      );
      await callback?.({
        text: "I couldn't understand which message to unpin. Please specify the message timestamp.",
        source: "slack",
      });
      return { success: false, error: "Could not extract unpin parameters" };
    }

    if (!isValidMessageTs(unpinInfo.messageTs)) {
      await callback?.({
        text: "The message timestamp format is invalid. Please provide a valid Slack message timestamp.",
        source: "slack",
      });
      return { success: false, error: "Invalid message timestamp" };
    }

    const stateData = state?.data;
    const room = stateData?.room || (await runtime.getRoom(message.roomId));
    const channelId = unpinInfo.channelId || room?.channelId;

    if (!channelId) {
      await callback?.({
        text: "I couldn't determine the channel for unpinning the message.",
        source: "slack",
      });
      return { success: false, error: "Could not determine channel" };
    }

    await slackService.unpinMessage(channelId, unpinInfo.messageTs);

    const response: Content = {
      text: "Message unpinned successfully.",
      source: message.content.source,
    };

    runtime.logger.debug(
      {
        src: "plugin:slack:action:unpin-message",
        messageTs: unpinInfo.messageTs,
        channelId,
      },
      "[SLACK_UNPIN_MESSAGE] Message unpinned",
    );

    await callback?.(response);

    return {
      success: true,
      data: {
        messageTs: unpinInfo.messageTs,
        channelId,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Unpin that old announcement",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll remove the pin from that message.",
          actions: ["SLACK_UNPIN_MESSAGE"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default unpinMessage;
