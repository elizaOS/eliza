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
  parseToonKeyValue,
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

Respond with TOON only:
messageTs: 1234567890.123456
newText: The updated message content
channelId:`;

export const editMessage: Action = {
  name: "SLACK_EDIT_MESSAGE",
  similes: [
    "UPDATE_SLACK_MESSAGE",
    "MODIFY_MESSAGE",
    "CHANGE_MESSAGE",
    "SLACK_UPDATE",
  ],
  description: "Edit an existing Slack message",
  descriptionCompressed: "Edit Slack message.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
  ): Promise<boolean> => {
    const __avTextRaw =
      typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["slack", "edit", "message"];
    const __avKeywordOk =
      __avKeywords.length > 0 &&
      __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:slack|edit|message)\b/i;
    const __avRegexOk = __avRegex.test(__avText);
    const __avSource = String(
      message?.content?.source ?? message?.metadata?.source ?? "",
    );
    const __avExpectedSource = "slack";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
    ): Promise<boolean> => {
      return message.content.source === "slack";
    };
    try {
      return Boolean(await __avLegacyValidate(runtime, message, state));
    } catch {
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const slackService = runtime.getService(SLACK_SERVICE_NAME) as SlackService;

    if (!slackService?.client) {
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

      const parsedResponse =
        parseToonKeyValue<Record<string, unknown>>(response);
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

    if (!editInfo?.messageTs || !editInfo.newText) {
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
