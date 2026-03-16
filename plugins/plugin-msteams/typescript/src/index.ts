// MS Teams Plugin for elizaOS
// Provides integration with Microsoft Teams via Bot Framework

// Export actions
export {
  SEND_ADAPTIVE_CARD_ACTION,
  SEND_MESSAGE_ACTION,
  SEND_POLL_ACTION,
  sendAdaptiveCardAction,
  sendMessageAction,
  sendPollAction,
} from "./actions/sendMessage";

// Export client
export { MAX_MEDIA_BYTES, MAX_MESSAGE_LENGTH, MSTeamsClient } from "./client";
// Export environment/config
export type {
  MSTeamsCredentials,
  MSTeamsEnvConfig,
  MSTeamsSettings,
} from "./environment";
export {
  buildMSTeamsSettings,
  msTeamsEnvSchema,
  resolveMSTeamsCredentials,
  validateMSTeamsConfig,
} from "./environment";
// Export providers
export {
  CHAT_STATE_PROVIDER,
  CONVERSATION_MEMBERS_PROVIDER,
  chatStateProvider,
  conversationMembersProvider,
  TEAM_INFO_PROVIDER,
  teamInfoProvider,
} from "./providers/chatState";
// Export service
export { MSTEAMS_SERVICE_NAME, MSTeamsService } from "./service";
// Export types
export type {
  AdaptiveCard,
  MSTeamsAttachment,
  MSTeamsCardActionPayload,
  MSTeamsChannel,
  MSTeamsChannelType,
  MSTeamsContent,
  MSTeamsConversation,
  MSTeamsConversationReference,
  MSTeamsConversationType,
  MSTeamsEntityPayload,
  MSTeamsGraphFile,
  MSTeamsGraphUser,
  MSTeamsMention,
  MSTeamsMessagePayload,
  MSTeamsPoll,
  MSTeamsPollVote,
  MSTeamsReactionPayload,
  MSTeamsSendOptions,
  MSTeamsSendResult,
  MSTeamsTeam,
  MSTeamsUser,
  MSTeamsWorldPayload,
} from "./types";
export { MSTeamsEventType } from "./types";

// Plugin metadata
export const PLUGIN_NAME = "msteams";
export const PLUGIN_VERSION = "2.0.0-alpha.1";
export const PLUGIN_DESCRIPTION =
  "Microsoft Teams integration for elizaOS agents via Bot Framework";

// Default export: Plugin definition
import type { Plugin } from "@elizaos/core";
import {
  sendAdaptiveCardAction,
  sendMessageAction,
  sendPollAction,
} from "./actions/sendMessage";
import {
  chatStateProvider,
  conversationMembersProvider,
  teamInfoProvider,
} from "./providers/chatState";
import { MSTeamsService } from "./service";

const msTeamsPlugin: Plugin = {
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  services: [MSTeamsService],
  actions: [sendMessageAction, sendPollAction, sendAdaptiveCardAction],
  providers: [chatStateProvider, conversationMembersProvider, teamInfoProvider],
};

export default msTeamsPlugin;

// Channel configuration types
export type {
  MsTeamsAccountConfig,
  MsTeamsActionConfig,
  MsTeamsChannelConfig,
  MsTeamsConfig,
  MsTeamsReactionNotificationMode,
  MsTeamsTeamConfig,
} from "./config";
