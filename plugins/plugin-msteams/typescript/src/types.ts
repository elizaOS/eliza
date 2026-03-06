import type {
  Content,
  EntityPayload,
  MessagePayload,
  WorldPayload,
} from "@elizaos/core";

/**
 * MS Teams conversation types
 */
export type MSTeamsConversationType = "personal" | "groupChat" | "channel";

/**
 * MS Teams channel type mapping to elizaOS
 */
export enum MSTeamsChannelType {
  PERSONAL = "personal",
  GROUP_CHAT = "groupChat",
  CHANNEL = "channel",
}

/**
 * MS Teams user information
 */
export interface MSTeamsUser {
  id: string;
  name?: string;
  aadObjectId?: string;
  email?: string;
  userPrincipalName?: string;
}

/**
 * MS Teams conversation information
 */
export interface MSTeamsConversation {
  id: string;
  conversationType?: MSTeamsConversationType;
  tenantId?: string;
  name?: string;
  isGroup?: boolean;
}

/**
 * MS Teams channel information
 */
export interface MSTeamsChannel {
  id: string;
  name?: string;
  tenantId?: string;
}

/**
 * MS Teams team information
 */
export interface MSTeamsTeam {
  id: string;
  name?: string;
  aadGroupId?: string;
}

/**
 * Stored conversation reference for proactive messaging
 */
export interface MSTeamsConversationReference {
  activityId?: string;
  user?: MSTeamsUser;
  bot?: MSTeamsUser;
  conversation: MSTeamsConversation;
  channelId: string;
  serviceUrl?: string;
  locale?: string;
}

/**
 * MS Teams message content type
 * Note: Does not extend Content to avoid index signature conflicts
 */
export interface MSTeamsContent extends Content {
  // No additional properties - use data field for MS Teams-specific content
}

/**
 * Internal type for MS Teams message handling (not exported to Content)
 */
export interface MSTeamsMessageContent {
  text?: string;
  adaptiveCard?: Record<string, unknown>;
  mentions?: MSTeamsMention[];
  attachments?: MSTeamsAttachment[];
}

/**
 * MS Teams mention
 */
export interface MSTeamsMention {
  mentioned: MSTeamsUser;
  text: string;
}

/**
 * MS Teams attachment
 */
export interface MSTeamsAttachment {
  contentType: string;
  contentUrl?: string;
  content?: unknown;
  name?: string;
  thumbnailUrl?: string;
}

/**
 * MS Teams poll definition
 */
export interface MSTeamsPoll {
  id: string;
  question: string;
  options: string[];
  maxSelections: number;
  createdAt: string;
  updatedAt?: string;
  conversationId?: string;
  messageId?: string;
  votes: Record<string, string[]>;
}

/**
 * MS Teams poll vote
 */
export interface MSTeamsPollVote {
  pollId: string;
  voterId: string;
  selections: string[];
}

/**
 * Event types emitted by the MS Teams plugin
 */
export enum MSTeamsEventType {
  WORLD_JOINED = "MSTEAMS_WORLD_JOINED",
  WORLD_CONNECTED = "MSTEAMS_WORLD_CONNECTED",
  WORLD_LEFT = "MSTEAMS_WORLD_LEFT",
  ENTITY_JOINED = "MSTEAMS_ENTITY_JOINED",
  ENTITY_LEFT = "MSTEAMS_ENTITY_LEFT",
  MESSAGE_RECEIVED = "MSTEAMS_MESSAGE_RECEIVED",
  MESSAGE_SENT = "MSTEAMS_MESSAGE_SENT",
  REACTION_RECEIVED = "MSTEAMS_REACTION_RECEIVED",
  CARD_ACTION_RECEIVED = "MSTEAMS_CARD_ACTION_RECEIVED",
  FILE_CONSENT_RECEIVED = "MSTEAMS_FILE_CONSENT_RECEIVED",
}

/**
 * MS Teams message payload
 */
export interface MSTeamsMessagePayload extends MessagePayload {
  activityId: string;
  conversationId: string;
  conversationType: MSTeamsConversationType;
  from: MSTeamsUser;
  conversation: MSTeamsConversation;
  serviceUrl: string;
  channelData?: Record<string, unknown>;
  replyToId?: string;
}

/**
 * MS Teams world payload
 */
export interface MSTeamsWorldPayload extends WorldPayload {
  team?: MSTeamsTeam;
  channel?: MSTeamsChannel;
  tenantId?: string;
}

/**
 * MS Teams entity payload
 */
export interface MSTeamsEntityPayload extends EntityPayload {
  user: MSTeamsUser;
  action: "added" | "removed" | "updated";
}

/**
 * MS Teams reaction payload
 */
export interface MSTeamsReactionPayload {
  activityId: string;
  conversationId: string;
  from: MSTeamsUser;
  reactionType: string;
  messageId: string;
}

/**
 * MS Teams card action payload
 */
export interface MSTeamsCardActionPayload {
  activityId: string;
  conversationId: string;
  from: MSTeamsUser;
  value: Record<string, unknown>;
}

/**
 * MS Teams send message options
 */
export interface MSTeamsSendOptions {
  /** Reply to a specific message */
  replyToId?: string;
  /** Send as a thread reply */
  threadId?: string;
  /** Include an Adaptive Card */
  adaptiveCard?: Record<string, unknown>;
  /** Include mentions */
  mentions?: MSTeamsMention[];
  /** Include media attachments */
  mediaUrls?: string[];
}

/**
 * MS Teams send message result
 */
export interface MSTeamsSendResult {
  messageId: string;
  conversationId: string;
  activityId?: string;
}

/**
 * Adaptive Card definition
 */
export interface AdaptiveCard {
  type: "AdaptiveCard";
  version: string;
  body: unknown[];
  actions?: unknown[];
}

/**
 * MS Teams Graph API user info
 */
export interface MSTeamsGraphUser {
  id: string;
  displayName: string;
  mail?: string;
  userPrincipalName?: string;
  jobTitle?: string;
  department?: string;
  officeLocation?: string;
}

/**
 * MS Teams Graph API file info
 */
export interface MSTeamsGraphFile {
  id: string;
  name: string;
  webUrl: string;
  downloadUrl?: string;
  size: number;
  mimeType?: string;
}
