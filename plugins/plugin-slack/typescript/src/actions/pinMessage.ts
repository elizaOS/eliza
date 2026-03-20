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

const pinMessageTemplate = `You are helping to extract pin message parameters for Slack.

The user wants to pin a message in a Slack channel.

Recent conversation:
{{recentMessages}}

Extract the following:
1. messageTs: The message timestamp to pin (format: 1234567890.123456)
2. channelId: The channel ID (optional, defaults to current channel)

Respond with a JSON object like:
{
  "messageTs": "1234567890.123456",
  "channelId": null
}

Only respond with the JSON object, no other text.`;

export const pinMessage: Action = {
  name: "SLACK_PIN_MESSAGE",
  similes: ["PIN_SLACK_MESSAGE", "PIN_MESSAGE", "SLACK_PIN", "SAVE_MESSAGE"],
  description: "Pin a message in a Slack channel",
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
      template: pinMessageTemplate,
    });

    let pinInfo: {
      messageTs: string;
      channelId?: string | null;
    } | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse = parseJSONObjectFromText(response);
      if (parsedResponse?.messageTs) {
        pinInfo = {
          messageTs: String(parsedResponse.messageTs),
          channelId: parsedResponse.channelId
            ? String(parsedResponse.channelId)
            : null,
        };
        break;
      }
    }

    if (!pinInfo || !pinInfo.messageTs) {
      runtime.logger.debug(
        { src: "plugin:slack:action:pin-message" },
        "[SLACK_PIN_MESSAGE] Could not extract pin info",
      );
      await callback?.({
        text: "I couldn't understand which message to pin. Please specify the message timestamp.",
        source: "slack",
      });
      return { success: false, error: "Could not extract pin parameters" };
    }

    if (!isValidMessageTs(pinInfo.messageTs)) {
      await callback?.({
        text: "The message timestamp format is invalid. Please provide a valid Slack message timestamp.",
        source: "slack",
      });
      return { success: false, error: "Invalid message timestamp" };
    }

    const stateData = state?.data;
    const room = stateData?.room || (await runtime.getRoom(message.roomId));
    const channelId = pinInfo.channelId || room?.channelId;

    if (!channelId) {
      await callback?.({
        text: "I couldn't determine the channel for pinning the message.",
        source: "slack",
      });
      return { success: false, error: "Could not determine channel" };
    }

    await slackService.pinMessage(channelId, pinInfo.messageTs);

    const response: Content = {
      text: "Message pinned successfully.",
      source: message.content.source,
    };

    runtime.logger.debug(
      {
        src: "plugin:slack:action:pin-message",
        messageTs: pinInfo.messageTs,
        channelId,
      },
      "[SLACK_PIN_MESSAGE] Message pinned",
    );

    await callback?.(response);

    return {
      success: true,
      data: {
        messageTs: pinInfo.messageTs,
        channelId,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Pin that important announcement",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll pin that message to the channel.",
          actions: ["SLACK_PIN_MESSAGE"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default pinMessage;
