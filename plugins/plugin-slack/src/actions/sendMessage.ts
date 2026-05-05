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
import { SLACK_SERVICE_NAME } from "../types";

const sendMessageTemplate = `You are helping to extract send message parameters for Slack.

The user wants to send a message to a Slack channel.

Recent conversation:
{{recentMessages}}

Extract the following:
1. text: The message text to send
2. channelRef: The channel to send to (default: "current" for the current channel, or a channel name/ID)
3. threadTs: Optional thread timestamp to reply in a thread (default: null)

Respond with TOON only:
text: The message to send
channelRef: current
threadTs:`;

export const sendMessage: Action = {
  name: "SLACK_SEND_MESSAGE",
  similes: [
    "SEND_SLACK_MESSAGE",
    "POST_TO_SLACK",
    "MESSAGE_SLACK",
    "SLACK_POST",
    "SEND_TO_CHANNEL",
  ],
  description: "Send a message to a Slack channel or thread",
  descriptionCompressed: "Send Slack channel/thread message.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
  ): Promise<boolean> => {
    const __avTextRaw =
      typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["slack", "send", "message"];
    const __avKeywordOk =
      __avKeywords.length > 0 &&
      __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:slack|send|message)\b/i;
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
      template: sendMessageTemplate,
    });

    let messageInfo: {
      text: string;
      channelRef?: string;
      threadTs?: string | null;
    } | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse =
        parseKeyValueXml<Record<string, unknown>>(response) ??
        parseJSONObjectFromText(response);
      if (parsedResponse?.text) {
        messageInfo = {
          text: String(parsedResponse.text),
          channelRef: parsedResponse.channelRef
            ? String(parsedResponse.channelRef)
            : "current",
          threadTs: parsedResponse.threadTs
            ? String(parsedResponse.threadTs)
            : undefined,
        };
        break;
      }
    }

    if (!messageInfo?.text) {
      runtime.logger.debug(
        { src: "plugin:slack:action:send-message" },
        "[SLACK_SEND_MESSAGE] Could not extract message info",
      );
      await callback?.({
        text: "I couldn't understand what message you want me to send. Please try again with a clearer request.",
        source: "slack",
      });
      return { success: false, error: "Could not extract message parameters" };
    }

    const stateData = state?.data;
    const room = stateData?.room || (await runtime.getRoom(message.roomId));

    if (!room?.channelId) {
      await callback?.({
        text: "I couldn't determine the current channel.",
        source: "slack",
      });
      return { success: false, error: "Could not determine channel" };
    }

    let targetChannelId = room.channelId;

    // If a specific channel was referenced (not "current"), try to find it
    if (messageInfo.channelRef && messageInfo.channelRef !== "current") {
      const channels = await slackService.listChannels();
      const targetChannel = channels.find((ch) => {
        const channelName = ch.name?.toLowerCase() || "";
        const searchTerm = messageInfo?.channelRef?.toLowerCase() || "";
        return (
          channelName === searchTerm ||
          channelName === searchTerm.replace(/^#/, "") ||
          ch.id === messageInfo?.channelRef
        );
      });
      if (targetChannel) {
        targetChannelId = targetChannel.id;
      }
    }

    const result = await slackService.sendMessage(
      targetChannelId,
      messageInfo.text,
      {
        threadTs: messageInfo.threadTs || undefined,
        replyBroadcast: undefined,
        unfurlLinks: undefined,
        unfurlMedia: undefined,
        mrkdwn: undefined,
        attachments: undefined,
        blocks: undefined,
      },
    );

    const response: Content = {
      text: "Message sent successfully.",
      source: message.content.source,
    };

    runtime.logger.debug(
      {
        src: "plugin:slack:action:send-message",
        messageTs: result.ts,
        channelId: targetChannelId,
      },
      "[SLACK_SEND_MESSAGE] Message sent successfully",
    );

    await callback?.(response);

    return {
      success: true,
      data: {
        messageTs: result.ts,
        channelId: targetChannelId,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Send a message to #general saying 'Hello everyone!'",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that message to #general for you.",
          actions: ["SLACK_SEND_MESSAGE"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Post 'Meeting starts in 5 minutes' to this channel",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll post that announcement here.",
          actions: ["SLACK_SEND_MESSAGE"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default sendMessage;
