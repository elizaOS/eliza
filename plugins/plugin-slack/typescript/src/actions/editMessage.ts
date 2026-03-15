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

const editMessageTemplate = `You are helping to extract edit message parameters for Slack.

The user wants to edit an existing Slack message.

Recent conversation:
{{recentMessages}}

Extract the following:
1. messageTs: The message timestamp to edit (format: 1234567890.123456)
2. newText: The new text content for the message
3. channelId: The channel ID (optional, defaults to current channel)

Respond with a JSON object like:
{
  "messageTs": "1234567890.123456",
  "newText": "The updated message content",
  "channelId": null
}

Only respond with the JSON object, no other text.`;

export const editMessage: Action = {
  name: "SLACK_EDIT_MESSAGE",
  similes: [
    "UPDATE_SLACK_MESSAGE",
    "MODIFY_MESSAGE",
    "CHANGE_MESSAGE",
    "SLACK_UPDATE",
  ],
  description: "Edit an existing Slack message",
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
      template: editMessageTemplate,
    });

    let editInfo: {
      messageTs: string;
      newText: string;
      channelId?: string | null;
    } | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse = parseJSONObjectFromText(response);
      if (parsedResponse?.messageTs && parsedResponse?.newText) {
        editInfo = {
          messageTs: String(parsedResponse.messageTs),
          newText: String(parsedResponse.newText),
          channelId: parsedResponse.channelId
            ? String(parsedResponse.channelId)
            : null,
        };
        break;
      }
    }

    if (!editInfo || !editInfo.messageTs || !editInfo.newText) {
      runtime.logger.debug(
        { src: "plugin:slack:action:edit-message" },
        "[SLACK_EDIT_MESSAGE] Could not extract edit info",
      );
      await callback?.({
        text: "I couldn't understand the edit request. Please specify the message timestamp and new content.",
        source: "slack",
      });
      return { success: false, error: "Could not extract edit parameters" };
    }

    if (!isValidMessageTs(editInfo.messageTs)) {
      await callback?.({
        text: "The message timestamp format is invalid. Please provide a valid Slack message timestamp.",
        source: "slack",
      });
      return { success: false, error: "Invalid message timestamp" };
    }

    const stateData = state?.data;
    const room = stateData?.room || (await runtime.getRoom(message.roomId));
    const channelId = editInfo.channelId || room?.channelId;

    if (!channelId) {
      await callback?.({
        text: "I couldn't determine the channel for the message edit.",
        source: "slack",
      });
      return { success: false, error: "Could not determine channel" };
    }

    await slackService.editMessage(
      channelId,
      editInfo.messageTs,
      editInfo.newText,
    );

    const response: Content = {
      text: "Message edited successfully.",
      source: message.content.source,
    };

    runtime.logger.debug(
      {
        src: "plugin:slack:action:edit-message",
        messageTs: editInfo.messageTs,
        channelId,
      },
      "[SLACK_EDIT_MESSAGE] Message edited",
    );

    await callback?.(response);

    return {
      success: true,
      data: {
        messageTs: editInfo.messageTs,
        channelId,
        newText: editInfo.newText,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Edit that message to say 'Meeting at 3pm' instead",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll update that message for you.",
          actions: ["SLACK_EDIT_MESSAGE"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default editMessage;
