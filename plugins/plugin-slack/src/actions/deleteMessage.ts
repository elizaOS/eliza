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
  parseKeyValueXml,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import type { SlackService } from "../service";
import { isValidMessageTs, SLACK_SERVICE_NAME } from "../types";

const deleteMessageTemplate = `You are helping to extract delete message parameters for Slack.

The user wants to delete a Slack message.

Recent conversation:
{{recentMessages}}

Extract the following:
1. messageTs: The message timestamp to delete (format: 1234567890.123456)
2. channelId: The channel ID (optional, defaults to current channel)

Respond with TOON only:
messageTs: 1234567890.123456
channelId:`;

export const deleteMessage: Action = {
  name: "SLACK_DELETE_MESSAGE",
  similes: ["REMOVE_SLACK_MESSAGE", "DELETE_MESSAGE", "SLACK_REMOVE"],
  description: "Delete a Slack message",
  descriptionCompressed: "Delete Slack message.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
  ): Promise<boolean> => {
    const __avTextRaw =
      typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["slack", "delete", "message"];
    const __avKeywordOk =
      __avKeywords.length > 0 &&
      __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:slack|delete|message)\b/i;
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
      template: deleteMessageTemplate,
    });

    let deleteInfo: {
      messageTs: string;
      channelId?: string | null;
    } | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse =
        parseKeyValueXml<Record<string, unknown>>(response) ??
        parseJSONObjectFromText(response);
      if (parsedResponse?.messageTs) {
        deleteInfo = {
          messageTs: String(parsedResponse.messageTs),
          channelId: parsedResponse.channelId
            ? String(parsedResponse.channelId)
            : null,
        };
        break;
      }
    }

    if (!deleteInfo?.messageTs) {
      runtime.logger.debug(
        { src: "plugin:slack:action:delete-message" },
        "[SLACK_DELETE_MESSAGE] Could not extract delete info",
      );
      await callback?.({
        text: "I couldn't understand which message to delete. Please specify the message timestamp.",
        source: "slack",
      });
      return { success: false, error: "Could not extract delete parameters" };
    }

    if (!isValidMessageTs(deleteInfo.messageTs)) {
      await callback?.({
        text: "The message timestamp format is invalid. Please provide a valid Slack message timestamp.",
        source: "slack",
      });
      return { success: false, error: "Invalid message timestamp" };
    }

    const stateData = state?.data;
    const room = stateData?.room || (await runtime.getRoom(message.roomId));
    const channelId = deleteInfo.channelId || room?.channelId;

    if (!channelId) {
      await callback?.({
        text: "I couldn't determine the channel for the message deletion.",
        source: "slack",
      });
      return { success: false, error: "Could not determine channel" };
    }

    await slackService.deleteMessage(channelId, deleteInfo.messageTs);

    const response: Content = {
      text: "Message deleted successfully.",
      source: message.content.source,
    };

    runtime.logger.debug(
      {
        src: "plugin:slack:action:delete-message",
        messageTs: deleteInfo.messageTs,
        channelId,
      },
      "[SLACK_DELETE_MESSAGE] Message deleted",
    );

    await callback?.(response);

    return {
      success: true,
      data: {
        messageTs: deleteInfo.messageTs,
        channelId,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Delete that last message I sent",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll delete that message for you.",
          actions: ["SLACK_DELETE_MESSAGE"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default deleteMessage;
