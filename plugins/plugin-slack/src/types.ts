/**
 * Shared type surface for the Slack plugin: the `SlackEventTypes` enum, the
 * connector's domain models (`SlackChannel`, `SlackMessage`, `SlackUser`,
 * event payload maps, …), the `ISlackService` contract, error classes, ID
 * validators, and constants (`SLACK_SERVICE_NAME`, `MAX_SLACK_MESSAGE_LENGTH`,
 * `MAX_SLACK_BLOCKS`, …). Consumed across `service.ts`, the connector provider,
 * and re-exported from `index.ts`.
 */
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

export interface SlackReactionPayload extends MessagePayload {
  reaction: string;
  userId: string;
  channelId: string;
  messageTs: string;
  itemUser: string | undefined;
}

interface SlackChannelPayload extends WorldPayload {
  channelId: string;
  channelName: string;
  channelType: SlackChannelType;
}

interface SlackMemberPayload extends EntityPayload {
  userId: string;
  channelId: string;
}

interface SlackAppMentionPayload extends MessagePayload {
  channelId: string;
  userId: string;
  threadTs: string | undefined;
}

interface SlackSlashCommandPayload extends EventPayload {
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

interface SlackChannelTopic {
  value: string;
  creator: string;
  lastSet: number;
}

interface SlackChannelPurpose {
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

interface SlackAttachmentField {
  title: string;
  value: string;
  short: boolean;
}

export interface SlackBlock {
  type: string;
  block_id?: string;
  elements: SlackBlockElement[] | undefined;
  text: SlackBlockText | undefined;
}

interface SlackBlockElement {
  type: string;
  text: SlackBlockText | undefined;
  action_id?: string;
  url: string | undefined;
  value: string | undefined;
  style: string | undefined;
}

interface SlackBlockText {
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

interface SlackTeamIcon {
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

function isValidSlackOpaqueId(id: string): boolean {
  if (id.length === 0 || id.length > 255 || /\s/u.test(id)) return false;
  for (const character of id) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) {
      return false;
    }
  }
  return true;
}

/** Validates a bounded opaque Slack conversation identifier. */
export function isValidChannelId(id: string): boolean {
  return isValidSlackOpaqueId(id);
}

/** Validates a bounded opaque Slack user identifier. */
export function isValidUserId(id: string): boolean {
  return isValidSlackOpaqueId(id);
}

/** Validates a bounded opaque Slack workspace identifier. */
export function isValidTeamId(id: string): boolean {
  return isValidSlackOpaqueId(id);
}

/**
 * Validates a Slack message timestamp format
 */
export function isValidMessageTs(ts: string): boolean {
  // Slack timestamps are in the format: 1234567890.123456
  return /^\d+\.\d{6}$/.test(ts);
}

/**
 * Normalizes a Slack permalink path timestamp (`p` digits with the decimal
 * removed) to the `seconds.microseconds` form `isValidMessageTs` accepts.
 * Current links use 16 digits, seconds-only links use 10, and the documented
 * `chat.getPermalink` examples use 15. Other widths stay rejected.
 *
 * The documented 15-digit examples omit a leading zero from the six-digit
 * fractional field. Slack's threaded example exposes the corresponding
 * six-decimal `thread_ts`, so left-padding restores the canonical value instead
 * of shifting the message timestamp by a decimal place.
 */
export function normalizeSlackPermalinkTimestamp(
  digits: string,
): string | null {
  if (!/^(?:\d{16}|\d{15}|\d{10})$/.test(digits)) {
    return null;
  }
  return `${digits.slice(0, 10)}.${digits.slice(10).padStart(6, "0")}`;
}

/** One DNS label, so a nested `.slack.com` cannot be spelled inside it. */
const SLACK_WORKSPACE_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Resolves a Slack `/archives/` permalink through the WHATWG URL parser and
 * returns its parts, or `null` if the input is not one.
 *
 * The origin is established by `URL`, not by a pattern over the raw string.
 * Textual matching cannot decide which characters end the authority: `?`, `#`,
 * and (for special schemes) `\` all terminate the host before a later
 * `.slack.com` suffix, so `https://attacker?x=.slack.com/archives/…` reads as
 * Slack to a regex while every real client resolves it to `attacker`. Banning
 * each delimiter as it is discovered leaves the next one open, so the host is
 * taken from `url.hostname` and the segments from `url.pathname`.
 *
 * Credentials and ports are rejected rather than ignored: `https://user@…`
 * would otherwise surface `user@workspace` as the workspace domain, which
 * round-trips back out through `buildSlackMessagePermalink`. Query and fragment
 * tails stay allowed — Slack's own threaded permalinks carry `?thread_ts=…`.
 */
export function parseSlackArchivesUrl(link: string): {
  workspaceDomain: string;
  channelId: string;
  messageTs: string;
} | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    // error-policy:J3 an unparseable link is not a permalink; the explicit
    // invalid result is `null`, never a partially-trusted default.
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.port !== "") {
    return null;
  }

  // `url.hostname` is already lowercased and IDNA-normalized.
  const host = url.hostname;
  const suffix = ".slack.com";
  if (!host.endsWith(suffix)) {
    return null;
  }
  const workspaceDomain = host.slice(0, -suffix.length);
  if (!SLACK_WORKSPACE_LABEL_RE.test(workspaceDomain)) {
    return null;
  }

  // Percent-encoded separators survive in `pathname`, so a segment carrying
  // `%2F` fails the character classes below instead of splitting into two.
  const segments = url.pathname.split("/");
  if (segments[segments.length - 1] === "") {
    segments.pop(); // one optional trailing slash
  }
  if (
    segments.length !== 4 ||
    segments[0] !== "" ||
    segments[1] !== "archives"
  ) {
    return null;
  }

  const channelId = segments[2];
  if (!/^[A-Z0-9]+$/i.test(channelId)) {
    return null;
  }

  const tsMatch = /^p(\d+)$/.exec(segments[3]);
  if (!tsMatch) {
    return null;
  }
  const messageTs = normalizeSlackPermalinkTimestamp(tsMatch[1]);
  if (!messageTs) {
    return null;
  }

  return { workspaceDomain, channelId, messageTs };
}

/**
 * Parses a Slack message link to extract channel and message IDs.
 *
 * Accepts only a bare permalink: a link embedded in surrounding prose or
 * wrapped in mrkdwn (`<https://…|label>`) returns `null`. Callers holding
 * message text extract the URL first, with `extractUrlFromSlackLink` for the
 * mrkdwn form.
 *
 * Narrower than `parseSlackMessagePermalink` on the channel only: this helper
 * feeds conversation APIs and so requires a conversation ID (`C`/`G`/`D`).
 */
export function parseSlackMessageLink(
  link: string,
): { channelId: string; messageTs: string } | null {
  // Format: https://workspace.slack.com/archives/C12345678/p1234567890123456
  const parsed = parseSlackArchivesUrl(link);
  if (!parsed) return null;

  const { channelId, messageTs } = parsed;
  if (!/^[CGD][A-Z0-9]+$/i.test(channelId)) return null;

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
