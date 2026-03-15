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

Respond with a JSON object like:
{
  "userId": "U0123456789"
}

Only respond with the JSON object, no other text.`;

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
      template: getUserInfoTemplate,
    });

    let userInfo: { userId: string } | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse = parseJSONObjectFromText(response);
      if (parsedResponse?.userId) {
        userInfo = {
          userId: String(parsedResponse.userId),
        };
        break;
      }
    }

    if (!userInfo || !userInfo.userId) {
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

    const response: Content = {
      text: `User information for ${displayName}:\n\n${userDetails}`,
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
