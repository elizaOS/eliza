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

const reactToMessageTemplate = `You are helping to extract reaction parameters for Slack.

The user wants to add a reaction (emoji) to a Slack message.

Recent conversation:
{{recentMessages}}

Extract the following:
1. emoji: The emoji name to react with (without colons, e.g., "thumbsup" not ":thumbsup:")
2. messageTs: The message timestamp to react to (format: 1234567890.123456)
3. channelId: The channel ID (optional, defaults to current channel)
4. remove: Whether to remove the reaction instead of adding it (default: false)

Respond with a JSON object like:
{
  "emoji": "thumbsup",
  "messageTs": "1234567890.123456",
  "channelId": null,
  "remove": false
}

Only respond with the JSON object, no other text.`;

export const reactToMessage: Action = {
  name: "SLACK_REACT_TO_MESSAGE",
  similes: [
    "ADD_SLACK_REACTION",
    "REACT_SLACK",
    "SLACK_EMOJI",
    "ADD_EMOJI",
    "REMOVE_REACTION",
  ],
  description: "Add or remove an emoji reaction to a Slack message",
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
      template: reactToMessageTemplate,
    });

    let reactionInfo: {
      emoji: string;
      messageTs: string;
      channelId?: string | null;
      remove?: boolean;
    } | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse = parseJSONObjectFromText(response);
      if (parsedResponse?.emoji && parsedResponse?.messageTs) {
        reactionInfo = {
          emoji: String(parsedResponse.emoji),
          messageTs: String(parsedResponse.messageTs),
          channelId: parsedResponse.channelId
            ? String(parsedResponse.channelId)
            : null,
          remove: Boolean(parsedResponse.remove),
        };
        break;
      }
    }

    if (!reactionInfo || !reactionInfo.emoji || !reactionInfo.messageTs) {
      runtime.logger.debug(
        { src: "plugin:slack:action:react-to-message" },
        "[SLACK_REACT_TO_MESSAGE] Could not extract reaction info",
      );
      await callback?.({
        text: "I couldn't understand the reaction request. Please specify the emoji and message to react to.",
        source: "slack",
      });
      return { success: false, error: "Could not extract reaction parameters" };
    }

    if (!isValidMessageTs(reactionInfo.messageTs)) {
      await callback?.({
        text: "The message timestamp format is invalid. Please provide a valid Slack message timestamp.",
        source: "slack",
      });
      return { success: false, error: "Invalid message timestamp" };
    }

    const stateData = state?.data;
    const room = stateData?.room || (await runtime.getRoom(message.roomId));
    const channelId = reactionInfo.channelId || room?.channelId;

    if (!channelId) {
      await callback?.({
        text: "I couldn't determine the channel for the reaction.",
        source: "slack",
      });
      return { success: false, error: "Could not determine channel" };
    }

    if (reactionInfo.remove) {
      await slackService.removeReaction(
        channelId,
        reactionInfo.messageTs,
        reactionInfo.emoji,
      );
    } else {
      await slackService.sendReaction(
        channelId,
        reactionInfo.messageTs,
        reactionInfo.emoji,
      );
    }

    const actionWord = reactionInfo.remove ? "removed" : "added";
    const response: Content = {
      text: `Reaction :${reactionInfo.emoji}: ${actionWord} successfully.`,
      source: message.content.source,
    };

    runtime.logger.debug(
      {
        src: "plugin:slack:action:react-to-message",
        emoji: reactionInfo.emoji,
        messageTs: reactionInfo.messageTs,
        channelId,
        remove: reactionInfo.remove,
      },
      `[SLACK_REACT_TO_MESSAGE] Reaction ${actionWord}`,
    );

    await callback?.(response);

    return {
      success: true,
      data: {
        emoji: reactionInfo.emoji,
        messageTs: reactionInfo.messageTs,
        channelId,
        action: reactionInfo.remove ? "removed" : "added",
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "React to the last message with a thumbs up",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll add a thumbs up reaction to that message.",
          actions: ["SLACK_REACT_TO_MESSAGE"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Add a :tada: emoji to that announcement",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Adding the tada emoji reaction now.",
          actions: ["SLACK_REACT_TO_MESSAGE"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default reactToMessage;
