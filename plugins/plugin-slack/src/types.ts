import type {
  Character,
  EntityPayload,
  EventPayload,
  MessagePayload,
  WorldPayload,
} from "@elizaos/core";
import type { App as BoltApp } from "@slack/bolt";

type WebClient = BoltApp["client"];

/**
 * Slack-specific event types
 */
export enum SlackEventTypes {
  MESSAGE_RECEIVED = "SLACK_MESSAGE_RECEIVED",
  MESSAGE_SENT = "SLACK_MESSAGE_SENT",
  REACTION_ADDED = "SLACK_REACTION_ADDED",
  REACTION_REMOVED = "SLACK_REACTION_REMOVED",
  CHANNEL_JOINED = "SLACK_CHANNEL_JOINED",
  CHANNEL_LEFT = "SLACK_CHANNEL_LEFT",
  MEMBER_JOINED_CHANNEL = "SLACK_MEMBER_JOINED_CHANNEL",
  MEMBER_LEFT_CHANNEL = "SLACK_MEMBER_LEFT_CHANNEL",
  APP_MENTION = "SLACK_APP_MENTION",
  SLASH_COMMAND = "SLACK_SLASH_COMMAND",
  FILE_SHARED = "SLACK_FILE_SHARED",
  THREAD_REPLY = "SLACK_THREAD_REPLY",
}

export interface SlackMessageReceivedPayload extends MessagePayload {
  channelId: string;
  threadTs: string | undefined;
  userId: string;
  teamId: string | undefined;
  isThreadReply: boolean;
  files: SlackFile[];
}

export interface SlackMessageSentPayload extends MessagePayload {
  channelId: string;
  threadTs: string | undefined;
  messageTs: string;
}

export interface SlackReactionPayload extends EventPayload {
  reaction: string;
  userId: string;
  channelId: string;
  messageTs: string;
  itemUser: string | undefined;
}

export interface SlackChannelPayload extends WorldPayload {
  channelId: string;
  channelName: string;
  channelType: SlackChannelType;
}

export interface SlackMemberPayload extends EntityPayload {
  userId: string;
  channelId: string;
}

export interface SlackAppMentionPayload extends MessagePayload {
  channelId: string;
  userId: string;
  threadTs: string | undefined;
}

export interface SlackSlashCommandPayload extends EventPayload {
  command: string;
  text: string;
  userId: string;
  channelId: string;
  teamId: string;
  responseUrl: string;
  triggerId: string;
}

export interface SlackFile {
  id: string;
  name: string;
  title: string;
  mimetype: string;
  filetype: string;
  size: number;
  urlPrivate: string;
  urlPrivateDownload: string | undefined;
  permalink: string;
  thumb64: string | undefined;
  thumb80: string | undefined;
  thumb360: string | undefined;
}

export type SlackChannelType = "channel" | "group" | "im" | "mpim";

export interface SlackEventPayloadMap {
  [SlackEventTypes.MESSAGE_RECEIVED]: SlackMessageReceivedPayload;
  [SlackEventTypes.MESSAGE_SENT]: SlackMessageSentPayload;
  [SlackEventTypes.REACTION_ADDED]: SlackReactionPayload;
  [SlackEventTypes.REACTION_REMOVED]: SlackReactionPayload;
  [SlackEventTypes.CHANNEL_JOINED]: SlackChannelPayload;
  [SlackEventTypes.CHANNEL_LEFT]: SlackChannelPayload;
  [SlackEventTypes.MEMBER_JOINED_CHANNEL]: SlackMemberPayload;
  [SlackEventTypes.MEMBER_LEFT_CHANNEL]: SlackMemberPayload;
  [SlackEventTypes.APP_MENTION]: SlackAppMentionPayload;
  [SlackEventTypes.SLASH_COMMAND]: SlackSlashCommandPayload;
  [SlackEventTypes.FILE_SHARED]: SlackMessageReceivedPayload;
  [SlackEventTypes.THREAD_REPLY]: SlackMessageReceivedPayload;
}

export interface SlackUser {
  id: string;
  teamId: string | undefined;
  name: string;
  deleted: boolean;
  realName: string | undefined;
  tz: string | undefined;
  tzLabel: string | undefined;
  tzOffset: number | undefined;
  profile: SlackUserProfile;
  isAdmin: boolean;
  isOwner: boolean;
  isPrimaryOwner: boolean;
  isRestricted: boolean;
  isUltraRestricted: boolean;
  isBot: boolean;
  isAppUser: boolean;
  updated: number;
}

export interface SlackUserProfile {
  title: string | undefined;
  phone: string | undefined;
  skype: string | undefined;
  realName: string | undefined;
  realNameNormalized: string | undefined;
  displayName: string | undefined;
  displayNameNormalized: string | undefined;
  statusText: string | undefined;
  statusEmoji: string | undefined;
  statusExpiration: number | undefined;
  avatarHash: string | undefined;
  email: string | undefined;
  image24: string | undefined;
  image32: string | undefined;
  image48: string | undefined;
  image72: string | undefined;
  image192: string | undefined;
  image512: string | undefined;
  image1024: string | undefined;
  imageOriginal: string | undefined;
  team: string | undefined;
}

export interface SlackChannel {
  id: string;
  name: string;
  isChannel: boolean;
  isGroup: boolean;
  isIm: boolean;
  isMpim: boolean;
  isPrivate: boolean;
  isArchived: boolean;
  isGeneral: boolean;
  isShared: boolean;
  isOrgShared: boolean;
  isMember: boolean;
  topic: SlackChannelTopic | undefined;
  purpose: SlackChannelPurpose | undefined;
  numMembers: number | undefined;
  created: number;
  creator: string;
}

export interface SlackChannelTopic {
  value: string;
  creator: string;
  lastSet: number;
}

export interface SlackChannelPurpose {
  value: string;
  creator: string;
  lastSet: number;
}

export interface SlackMessage {
  type: string;
  subtype: string | undefined;
  ts: string;
  user: string | undefined;
  text: string;
  threadTs: string | undefined;
  replyCount: number | undefined;
  replyUsersCount: number | undefined;
  latestReply: string | undefined;
  reactions: SlackReaction[] | undefined;
  files: SlackFile[] | undefined;
  attachments: SlackAttachment[] | undefined;
  blocks: SlackBlock[] | undefined;
}

export interface SlackReaction {
  name: string;
  count: number;
  users: string[];
}

export interface SlackAttachment {
  id: number;
  fallback: string | undefined;
  color: string | undefined;
  pretext: string | undefined;
  authorName: string | undefined;
  authorLink: string | undefined;
  authorIcon: string | undefined;
  title: string | undefined;
  titleLink: string | undefined;
  text: string | undefined;
  fields: SlackAttachmentField[] | undefined;
  imageUrl: string | undefined;
  thumbUrl: string | undefined;
  footer: string | undefined;
  footerIcon: string | undefined;
  ts: string | undefined;
}

export interface SlackAttachmentField {
  title: string;
  value: string;
  short: boolean;
}

export interface SlackBlock {
  type: string;
  blockId: string | undefined;
  elements: SlackBlockElement[] | undefined;
  text: SlackBlockText | undefined;
}

export interface SlackBlockElement {
  type: string;
  text: SlackBlockText | undefined;
  actionId: string | undefined;
  url: string | undefined;
  value: string | undefined;
  style: string | undefined;
}

export interface SlackBlockText {
  type: string;
  text: string;
  emoji: boolean | undefined;
  verbatim: boolean | undefined;
}

export interface SlackTeam {
  id: string;
  name: string;
  domain: string;
  emailDomain: string | undefined;
  icon: SlackTeamIcon;
}

export interface SlackTeamIcon {
  image34: string | undefined;
  image44: string | undefined;
  image68: string | undefined;
  image88: string | undefined;
  image102: string | undefined;
  image132: string | undefined;
  image230: string | undefined;
  imageDefault: boolean;
}

export interface ISlackService {
  app: BoltApp | null;
  client: WebClient | null;
  character: Character;
  botUserId: string | null;
  teamId: string | null;
}

export const SLACK_SERVICE_NAME = "slack";

export const ServiceType = {
  SLACK: "slack",
} as const;

export interface SlackSettings {
  allowedChannelIds: string[] | undefined;
  shouldIgnoreBotMessages: boolean;
  shouldRespondOnlyToMentions: boolean;
}

export interface SlackMessageSendOptions {
  threadTs: string | undefined;
  replyBroadcast: boolean | undefined;
  unfurlLinks: boolean | undefined;
  unfurlMedia: boolean | undefined;
  mrkdwn: boolean | undefined;
  attachments: SlackAttachment[] | undefined;
  blocks: SlackBlock[] | undefined;
}

export class SlackPluginError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "SlackPluginError";
  }
}

export class SlackServiceNotInitializedError extends SlackPluginError {
  constructor() {
    super("Slack service is not initialized", "SERVICE_NOT_INITIALIZED");
    this.name = "SlackServiceNotInitializedError";
  }
}

export class SlackClientNotAvailableError extends SlackPluginError {
  constructor() {
    super("Slack client is not available", "CLIENT_NOT_AVAILABLE");
    this.name = "SlackClientNotAvailableError";
  }
}

export class SlackConfigurationError extends SlackPluginError {
  constructor(missingConfig: string) {
    super(`Missing required configuration: ${missingConfig}`, "MISSING_CONFIG");
    this.name = "SlackConfigurationError";
  }
}

export class SlackApiError extends SlackPluginError {
  constructor(
    message: string,
    public readonly apiErrorCode: string | undefined,
  ) {
    super(message, "API_ERROR");
    this.name = "SlackApiError";
  }
}

/**
 * Validates a Slack channel ID format
 */
export function isValidChannelId(id: string): boolean {
  // Slack channel IDs start with C (public), G (private/group), or D (DM)
  return /^[CGD][A-Z0-9]{8,}$/i.test(id);
}

/**
 * Validates a Slack user ID format
 */
export function isValidUserId(id: string): boolean {
  // Slack user IDs start with U or W (enterprise grid)
  return /^[UW][A-Z0-9]{8,}$/i.test(id);
}

/**
 * Validates a Slack team ID format
 */
export function isValidTeamId(id: string): boolean {
  // Slack team IDs start with T
  return /^T[A-Z0-9]{8,}$/i.test(id);
}

/**
 * Validates a Slack message timestamp format
 */
export function isValidMessageTs(ts: string): boolean {
  // Slack timestamps are in the format: 1234567890.123456
  return /^\d+\.\d{6}$/.test(ts);
}

/**
 * Parses a Slack message link to extract channel and message IDs
 */
export function parseSlackMessageLink(
  link: string,
): { channelId: string; messageTs: string } | null {
  // Format: https://workspace.slack.com/archives/C12345678/p1234567890123456
  const match = link.match(/\/archives\/([CGD][A-Z0-9]+)\/p(\d+)/i);
  if (!match) return null;

  const channelId = match[1];
  const ts = match[2];
  // Convert the timestamp: p1234567890123456 -> 1234567890.123456
  const messageTs = `${ts.slice(0, 10)}.${ts.slice(10)}`;

  return { channelId, messageTs };
}

/**
 * Formats a message timestamp for use in Slack links
 */
export function formatMessageTsForLink(ts: string): string {
  // Convert: 1234567890.123456 -> p1234567890123456
  return `p${ts.replace(".", "")}`;
}

/**
 * Gets the display name for a Slack user
 */
export function getSlackUserDisplayName(user: SlackUser): string {
  return user.profile.displayName || user.profile.realName || user.name;
}

/**
 * Determines the channel type from a Slack channel object
 */
export function getSlackChannelType(channel: SlackChannel): SlackChannelType {
  if (channel.isIm) return "im";
  if (channel.isMpim) return "mpim";
  if (channel.isGroup || channel.isPrivate) return "group";
  return "channel";
}

/**
 * Maximum message length for Slack messages
 */
export const MAX_SLACK_MESSAGE_LENGTH = 4000;

/**
 * Maximum number of blocks per message
 */
export const MAX_SLACK_BLOCKS = 50;

/**
 * Maximum file size for uploads (in bytes) - 1GB for paid, varies for free
 */
export const MAX_SLACK_FILE_SIZE = 1024 * 1024 * 1024;
