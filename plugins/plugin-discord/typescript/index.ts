import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import chatWithAttachments from "./actions/chatWithAttachments";
import createPoll from "./actions/createPoll";
import { downloadMedia } from "./actions/downloadMedia";
import getUserInfo from "./actions/getUserInfo";
import joinChannel from "./actions/joinChannel";
import leaveChannel from "./actions/leaveChannel";
import listChannels from "./actions/listChannels";
import pinMessage from "./actions/pinMessage";
import reactToMessage from "./actions/reactToMessage";
import readChannel from "./actions/readChannel";
import searchMessages from "./actions/searchMessages";
import sendDM from "./actions/sendDM";
import sendMessage from "./actions/sendMessage";
import serverInfo from "./actions/serverInfo";
import { summarize } from "./actions/summarizeConversation";
import { transcribeMedia } from "./actions/transcribeMedia";
import unpinMessage from "./actions/unpinMessage";
import { printBanner } from "./banner";
import { getPermissionValues } from "./permissions";
import { channelStateProvider } from "./providers/channelState";
import { guildInfoProvider } from "./providers/guildInfo";
import { voiceStateProvider } from "./providers/voiceState";
import { DiscordService } from "./service";
import { DiscordTestSuite } from "./tests";

const discordPlugin: Plugin = {
  name: "discord",
  description: "Discord service plugin for integration with Discord servers and channels",
  services: [DiscordService],
  actions: [
    chatWithAttachments,
    downloadMedia,
    joinChannel,
    leaveChannel,
    listChannels,
    readChannel,
    sendDM,
    sendMessage,
    summarize,
    transcribeMedia,
    searchMessages,
    createPoll,
    getUserInfo,
    reactToMessage,
    pinMessage,
    unpinMessage,
    serverInfo,
  ],
  providers: [channelStateProvider, voiceStateProvider, guildInfoProvider],
  tests: [new DiscordTestSuite()],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    const token = runtime.getSetting("DISCORD_API_TOKEN") as string;
    const applicationId = runtime.getSetting("DISCORD_APPLICATION_ID") as string;
    const voiceChannelId = runtime.getSetting("DISCORD_VOICE_CHANNEL_ID") as string;
    const channelIds = runtime.getSetting("CHANNEL_IDS") as string;
    const listenChannelIds = runtime.getSetting("DISCORD_LISTEN_CHANNEL_IDS") as string;
    const ignoreBotMessages = runtime.getSetting("DISCORD_SHOULD_IGNORE_BOT_MESSAGES") as string;
    const ignoreDirectMessages = runtime.getSetting(
      "DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES"
    ) as string;
    const respondOnlyToMentions = runtime.getSetting(
      "DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS"
    ) as string;

    printBanner({
      pluginName: "plugin-discord",
      description: "Discord bot integration for servers and channels",
      applicationId: applicationId || undefined,
      discordPermissions: applicationId ? getPermissionValues() : undefined,
      settings: [
        {
          name: "DISCORD_API_TOKEN",
          value: token,
          sensitive: true,
          required: true,
        },
        {
          name: "DISCORD_APPLICATION_ID",
          value: applicationId,
        },
        {
          name: "DISCORD_VOICE_CHANNEL_ID",
          value: voiceChannelId,
        },
        {
          name: "CHANNEL_IDS",
          value: channelIds,
        },
        {
          name: "DISCORD_LISTEN_CHANNEL_IDS",
          value: listenChannelIds,
        },
        {
          name: "DISCORD_SHOULD_IGNORE_BOT_MESSAGES",
          value: ignoreBotMessages,
          defaultValue: "false",
        },
        {
          name: "DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES",
          value: ignoreDirectMessages,
          defaultValue: "false",
        },
        {
          name: "DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
          value: respondOnlyToMentions,
          defaultValue: "false",
        },
      ],
      runtime,
    });

    if (!token || token.trim() === "") {
      logger.warn(
        "Discord API Token not provided - Discord plugin is loaded but will not be functional"
      );
      logger.warn(
        "To enable Discord functionality, please provide DISCORD_API_TOKEN in your .eliza/.env file"
      );
    }
  },
};

export default discordPlugin;

export { DISCORD_SERVICE_NAME } from "./constants";
export {
  ELEVATED_PERMISSIONS,
  hasElevatedPermissions,
  isElevatedRole,
} from "./permissionEvents";
export {
  type DiscordPermissionTier,
  DiscordPermissionTiers,
  type DiscordPermissionValues,
  generateAllInviteUrls,
  generateInviteUrl,
  getPermissionValues,
} from "./permissions";
export type { DiscordService as IDiscordService } from "./service";
export { DiscordService } from "./service";
export type {
  AuditInfo,
  ChannelPermissionsChangedPayload,
  MemberRolesChangedPayload,
  PermissionDiff,
  PermissionState,
  RoleLifecyclePayload,
  RolePermissionsChangedPayload,
} from "./types";
export { DiscordEventTypes } from "./types";
