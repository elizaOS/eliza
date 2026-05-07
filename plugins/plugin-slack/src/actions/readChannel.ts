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

Respond with JSON only. Return exactly one JSON object with this shape:
{"channelRef":"current","limit":10,"before":null,"after":null}`;

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value.trim()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readParams(
  options?: HandlerOptions | unknown,
): Record<string, unknown> {
  const direct =
    options && typeof options === "object"
      ? (options as Record<string, unknown>)
      : {};
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

function normalizeReadInfo(params: Record<string, unknown>): {
  channelRef?: string;
  limit?: number;
  before?: string | null;
  after?: string | null;
} | null {
  const hasReadableField = [
    "channelRef",
    "channel",
    "limit",
    "before",
    "after",
  ].some((key) => params[key] !== undefined);
  if (!hasReadableField) {
    return null;
  }

  const rawLimit = Number(params.limit);
  return {
    channelRef:
      typeof params.channelRef === "string" &&
      params.channelRef.trim().length > 0
        ? params.channelRef
        : typeof params.channel === "string" && params.channel.trim().length > 0
          ? params.channel
          : "current",
    limit: Number.isFinite(rawLimit) ? Math.min(rawLimit, 100) : 10,
    before:
      typeof params.before === "string" && params.before.trim().length > 0
        ? params.before
        : undefined,
    after:
      typeof params.after === "string" && params.after.trim().length > 0
        ? params.after
        : undefined,
  };
}

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
  descriptionCompressed: "Read Slack channel message history.",
  contexts: ["messaging", "connectors"],
  contextGate: { anyOf: ["messaging", "connectors"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "channelRef",
      description: "Slack channel name/id or current.",
      required: false,
      schema: { type: "string", default: "current" },
    },
    {
      name: "limit",
      description: "Maximum messages to read.",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 100, default: 10 },
    },
    {
      name: "after",
      description: "Optional lower bound timestamp or date.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
  ): Promise<boolean> => {
    const __avTextRaw =
      typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["slack", "read", "channel"];
    const __avKeywordOk =
      __avKeywords.length > 0 &&
      __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:slack|read|channel)\b/i;
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

    let readInfo: {
      channelRef?: string;
      limit?: number;
      before?: string | null;
      after?: string | null;
    } | null = normalizeReadInfo(readParams(_options));

    if (!readInfo) {
      const prompt = composePromptFromState({
        state,
        template: readChannelTemplate,
      });

      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        });

        const parsedResponse = parseJsonObject(response);
        if (parsedResponse) {
          readInfo = normalizeReadInfo(parsedResponse);
          if (readInfo) {
            break;
          }
        }
      }
    }

    if (!readInfo) {
      readInfo = { channelRef: "current", limit: 10 };
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
