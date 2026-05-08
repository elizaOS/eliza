import {
  getConnectorAccountManager,
  type IAgentRuntime,
  logger,
  type Plugin,
} from "@elizaos/core";
import { createSlackConnectorAccountProvider } from "./connector-account-provider";

import { SlackService } from "./service";

const slackPlugin: Plugin = {
  name: "slack",
  description: "Slack integration plugin for ElizaOS with Socket Mode support",
  services: [SlackService],
  actions: [],
  providers: [],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    // Register with the ConnectorAccountManager so the generic HTTP CRUD +
    // OAuth surface can list, create, patch, delete, and run OAuth v2 install
    // flows for Slack workspaces.
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createSlackConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:slack",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Slack provider with ConnectorAccountManager",
      );
    }

    const botToken = runtime.getSetting("SLACK_BOT_TOKEN") as string;
    const appToken = runtime.getSetting("SLACK_APP_TOKEN") as string;
    const signingSecret = runtime.getSetting("SLACK_SIGNING_SECRET") as string;
    const userToken = runtime.getSetting("SLACK_USER_TOKEN") as string;
    const channelIds = runtime.getSetting("SLACK_CHANNEL_IDS") as string;
    const ignoreBotMessages = runtime.getSetting(
      "SLACK_SHOULD_IGNORE_BOT_MESSAGES",
    ) as string;
    const respondOnlyToMentions = runtime.getSetting(
      "SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS",
    ) as string;

    // Log configuration status
    const maskToken = (token: string | undefined): string => {
      if (!token || token.trim() === "") return "[not set]";
      if (token.length <= 8) return "***";
      return `${token.slice(0, 4)}...${token.slice(-4)}`;
    };

    logger.info(
      {
        src: "plugin:slack",
        agentId: runtime.agentId,
        settings: {
          botToken: maskToken(botToken),
          appToken: maskToken(appToken),
          signingSecret: signingSecret ? "[set]" : "[not set]",
          userToken: maskToken(userToken),
          channelIds: channelIds || "[all channels]",
          ignoreBotMessages: ignoreBotMessages || "false",
          respondOnlyToMentions: respondOnlyToMentions || "false",
        },
      },
      "Slack plugin initializing",
    );

    if (!botToken || botToken.trim() === "") {
      logger.warn(
        { src: "plugin:slack", agentId: runtime.agentId },
        "SLACK_BOT_TOKEN not provided - Slack plugin is loaded but will not be functional",
      );
      logger.warn(
        { src: "plugin:slack", agentId: runtime.agentId },
        "To enable Slack functionality, please provide SLACK_BOT_TOKEN in your .env file",
      );
      return;
    }

    if (!appToken || appToken.trim() === "") {
      logger.warn(
        { src: "plugin:slack", agentId: runtime.agentId },
        "SLACK_APP_TOKEN not provided - Socket Mode will not work",
      );
      logger.warn(
        { src: "plugin:slack", agentId: runtime.agentId },
        "To enable Socket Mode, please provide SLACK_APP_TOKEN in your .env file",
      );
      return;
    }

    // Validate token formats
    if (!botToken.startsWith("xoxb-")) {
      logger.warn(
        { src: "plugin:slack", agentId: runtime.agentId },
        "SLACK_BOT_TOKEN should start with 'xoxb-'. Please verify your token.",
      );
    }

    if (!appToken.startsWith("xapp-")) {
      logger.warn(
        { src: "plugin:slack", agentId: runtime.agentId },
        "SLACK_APP_TOKEN should start with 'xapp-'. Please verify your token.",
      );
    }

    if (userToken && !userToken.startsWith("xoxp-")) {
      logger.warn(
        { src: "plugin:slack", agentId: runtime.agentId },
        "SLACK_USER_TOKEN should start with 'xoxp-'. Please verify your token.",
      );
    }

    logger.info(
      { src: "plugin:slack", agentId: runtime.agentId },
      "Slack plugin configuration validated successfully",
    );
  },
};

export default slackPlugin;

// Account management exports
export {
  DEFAULT_ACCOUNT_ID,
  isMultiAccountEnabled,
  listEnabledSlackAccounts,
  listSlackAccountIds,
  normalizeAccountId,
  type ResolvedSlackAccount,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  resolveSlackAppToken,
  resolveSlackBotToken,
  resolveSlackReplyToMode,
  resolveSlackUserToken,
  type SlackAccountConfig,
  type SlackActionConfig,
  type SlackChannelConfig,
  type SlackDmConfig,
  type SlackMultiAccountConfig,
  type SlackReactionNotificationMode,
  type SlackSlashCommandConfig,
  type SlackTokenSource,
} from "./accounts";
// Channel configuration types
export type {
  SlackConfig,
  SlackThreadConfig,
} from "./config";
export { createSlackConnectorAccountProvider } from "./connector-account-provider";
// Formatting exports
export {
  buildSlackMessagePermalink,
  type ChunkSlackTextOpts,
  chunkSlackText,
  escapeSlackMrkdwn,
  extractChannelIdFromMention,
  extractUrlFromSlackLink,
  extractUserIdFromMention,
  formatSlackChannel,
  formatSlackChannelMention,
  formatSlackDate,
  formatSlackLink,
  formatSlackSpecialMention,
  formatSlackUserDisplayName,
  formatSlackUserGroupMention,
  formatSlackUserMention,
  getChannelTypeString,
  isDirectMessage,
  isGroupDm,
  isPrivateChannel,
  markdownToSlackMrkdwn,
  markdownToSlackMrkdwnChunks,
  parseSlackMessagePermalink,
  resolveSlackSystemLocation,
  stripSlackFormatting,
  truncateText,
} from "./formatting";
// Export service for direct access
export { SlackService } from "./service";
// Export types
export type {
  ISlackService,
  SlackChannel,
  SlackChannelType,
  SlackEventPayloadMap,
  SlackFile,
  SlackMessage,
  SlackMessageReceivedPayload,
  SlackMessageSendOptions,
  SlackMessageSentPayload,
  SlackReaction,
  SlackReactionPayload,
  SlackSettings,
  SlackTeam,
  SlackUser,
  SlackUserProfile,
} from "./types";
export {
  formatMessageTsForLink,
  getSlackChannelType,
  getSlackUserDisplayName,
  isValidChannelId,
  isValidMessageTs,
  isValidTeamId,
  isValidUserId,
  MAX_SLACK_BLOCKS,
  MAX_SLACK_FILE_SIZE,
  MAX_SLACK_MESSAGE_LENGTH,
  parseSlackMessageLink,
  SLACK_SERVICE_NAME,
  SlackApiError,
  SlackClientNotAvailableError,
  SlackConfigurationError,
  SlackEventTypes,
  SlackPluginError,
  SlackServiceNotInitializedError,
} from "./types";
