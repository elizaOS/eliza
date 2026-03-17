import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import deleteMessage from "./actions/deleteMessage";
import editMessage from "./actions/editMessage";
import emojiList from "./actions/emojiList";
import getUserInfo from "./actions/getUserInfo";
import listChannels from "./actions/listChannels";
import listPins from "./actions/listPins";
import pinMessage from "./actions/pinMessage";
import reactToMessage from "./actions/reactToMessage";
import readChannel from "./actions/readChannel";
// Actions
import sendMessage from "./actions/sendMessage";
import unpinMessage from "./actions/unpinMessage";

// Providers
import { channelStateProvider } from "./providers/channelState";
import { memberListProvider } from "./providers/memberList";
import { workspaceInfoProvider } from "./providers/workspaceInfo";

// Service
import { SlackService } from "./service";

const slackPlugin: Plugin = {
  name: "slack",
  description: "Slack integration plugin for elizaOS with Socket Mode support",
  services: [SlackService],
  actions: [
    sendMessage,
    reactToMessage,
    readChannel,
    editMessage,
    deleteMessage,
    pinMessage,
    unpinMessage,
    listChannels,
    getUserInfo,
    listPins,
    emojiList,
  ],
  providers: [channelStateProvider, workspaceInfoProvider, memberListProvider],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
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
export { deleteMessage } from "./actions/deleteMessage";
export { editMessage } from "./actions/editMessage";
export { emojiList } from "./actions/emojiList";
export { getUserInfo } from "./actions/getUserInfo";
export { listChannels } from "./actions/listChannels";
export { listPins } from "./actions/listPins";
export { pinMessage } from "./actions/pinMessage";
export { reactToMessage } from "./actions/reactToMessage";
export { readChannel } from "./actions/readChannel";
// Export actions
export { sendMessage } from "./actions/sendMessage";
export { unpinMessage } from "./actions/unpinMessage";
// Channel configuration types (SlackAccountConfig, SlackActionConfig, etc. from ./accounts)
export type {
  SlackConfig,
  SlackThreadConfig,
} from "./config";
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
// Export providers
export { channelStateProvider } from "./providers/channelState";
export { memberListProvider } from "./providers/memberList";
export { workspaceInfoProvider } from "./providers/workspaceInfo";
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
