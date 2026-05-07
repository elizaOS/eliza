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
import {
  getSlackUserDisplayName,
  isValidUserId,
  SLACK_SERVICE_NAME,
} from "../types";

const getUserInfoTemplate = `You are helping to extract user info parameters for Slack.

The user wants to get information about a Slack user.

Recent conversation:
{{recentMessages}}

Extract the following:
1. userId: The Slack user ID to look up (format: U followed by alphanumeric characters, e.g., U0123456789)

Respond with JSON only. Return exactly one JSON object with this shape:
{"userId":"U0123456789"}`;

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

function readUserId(options?: HandlerOptions | unknown): string | null {
  const params = readParams(options);
  const value = params.userId ?? params.user;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

const MAX_SLACK_USER_INFO_TEXT_CHARS = 2_000;
const SLACK_USER_INFO_TIMEOUT_MS = 30_000;

function truncateActionText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

export const getUserInfo: Action = {
  name: "SLACK_GET_USER_INFO",
  similes: [
    "GET_SLACK_USER",
    "USER_INFO",
    "SLACK_USER",
    "MEMBER_INFO",
    "WHO_IS",
  ],
  description: "Get information about a Slack user",
  descriptionCompressed: "Get Slack user info.",
  contexts: ["messaging", "connectors"],
  contextGate: { anyOf: ["messaging", "connectors"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "userId",
      description: "Slack user ID to look up, such as U0123456789.",
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
    const __avStructuredUserId = readUserId(options);
    const __avKeywords = ["slack", "get", "user", "info"];
    const __avKeywordOk =
      Boolean(__avStructuredUserId) ||
      (__avKeywords.length > 0 &&
        __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw)));
    const __avRegex = /\b(?:slack|get|user|info)\b/i;
    const __avRegexOk =
      Boolean(__avStructuredUserId) || __avRegex.test(__avText);
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

    const directUserId = readUserId(_options);
    let userInfo: { userId: string } | null = directUserId
      ? { userId: directUserId }
      : null;

    if (!userInfo) {
      const prompt = composePromptFromState({
        state,
        template: getUserInfoTemplate,
      });

      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        });

        const parsedResponse = parseJsonObject(response);
        if (parsedResponse?.userId) {
          userInfo = {
            userId: String(parsedResponse.userId),
          };
          break;
        }
      }
    }

    if (!userInfo?.userId) {
      runtime.logger.debug(
        { src: "plugin:slack:action:get-user-info" },
        "[SLACK_GET_USER_INFO] Could not extract user info",
      );
      await callback?.({
        text: "I couldn't determine which user to look up. Please specify a user ID.",
        source: "slack",
      });
      return { success: false, error: "Could not extract user ID" };
    }

    if (!isValidUserId(userInfo.userId)) {
      await callback?.({
        text: "The user ID format is invalid. Slack user IDs start with U followed by alphanumeric characters.",
        source: "slack",
      });
      return { success: false, error: "Invalid user ID format" };
    }

    const user = await slackService.getUser(userInfo.userId);

    if (!user) {
      await callback?.({
        text: `I couldn't find a user with ID ${userInfo.userId}.`,
        source: "slack",
      });
      return { success: false, error: "User not found" };
    }

    const displayName = getSlackUserDisplayName(user);
    const roles: string[] = [];
    if (user.isAdmin) roles.push("Admin");
    if (user.isOwner) roles.push("Owner");
    if (user.isPrimaryOwner) roles.push("Primary Owner");
    if (user.isBot) roles.push("Bot");
    if (user.isRestricted) roles.push("Guest");

    const userDetails = [
      `**Name:** ${displayName}`,
      user.profile.realName && user.profile.realName !== displayName
        ? `**Real Name:** ${user.profile.realName}`
        : null,
      `**Username:** @${user.name}`,
      user.profile.title ? `**Title:** ${user.profile.title}` : null,
      user.profile.email ? `**Email:** ${user.profile.email}` : null,
      user.tz ? `**Timezone:** ${user.tzLabel || user.tz}` : null,
      user.profile.statusText
        ? `**Status:** ${user.profile.statusEmoji || ""} ${user.profile.statusText}`
        : null,
      roles.length > 0 ? `**Roles:** ${roles.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const timeoutMs = SLACK_USER_INFO_TIMEOUT_MS;

    const response: Content = {
      text: truncateActionText(
        `User information for ${displayName}:\n\n${userDetails}`,
        MAX_SLACK_USER_INFO_TEXT_CHARS,
      ),
      source: message.content.source,
    };

    runtime.logger.debug(
      {
        src: "plugin:slack:action:get-user-info",
        userId: userInfo.userId,
        displayName,
      },
      "[SLACK_GET_USER_INFO] User info retrieved",
    );

    await callback?.(response);

    return {
      success: true,
      data: {
        userId: user.id,
        name: user.name,
        displayName,
        realName: user.profile.realName,
        title: user.profile.title,
        email: user.profile.email,
        timezone: user.tz,
        isAdmin: user.isAdmin,
        isOwner: user.isOwner,
        isBot: user.isBot,
        statusText: user.profile.statusText,
        statusEmoji: user.profile.statusEmoji,
        avatar: user.profile.image192 || user.profile.image72,
        timeoutMs,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Who is U0123456789?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Let me look up that user for you.",
          actions: ["SLACK_GET_USER_INFO"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Get information about the user who sent the last message",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll fetch their profile information.",
          actions: ["SLACK_GET_USER_INFO"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default getUserInfo;
