import type { Content, EntityPayload, MessagePayload, WorldPayload } from "@elizaos/core";

/**
 * Mattermost-specific content with optional file attachments.
 */
export interface MattermostContent extends Content {
  fileIds?: string[];
  rootId?: string;
}

/**
 * Event types emitted by the Mattermost plugin.
 */
export enum MattermostEventTypes {
  WORLD_JOINED = "MATTERMOST_WORLD_JOINED",
  WORLD_CONNECTED = "MATTERMOST_WORLD_CONNECTED",
  WORLD_LEFT = "MATTERMOST_WORLD_LEFT",
  ENTITY_JOINED = "MATTERMOST_ENTITY_JOINED",
  ENTITY_LEFT = "MATTERMOST_ENTITY_LEFT",
  ENTITY_UPDATED = "MATTERMOST_ENTITY_UPDATED",
  MESSAGE_RECEIVED = "MATTERMOST_MESSAGE_RECEIVED",
  MESSAGE_SENT = "MATTERMOST_MESSAGE_SENT",
  REACTION_RECEIVED = "MATTERMOST_REACTION_RECEIVED",
  INTERACTION_RECEIVED = "MATTERMOST_INTERACTION_RECEIVED",
}

/**
 * Mattermost channel types.
 */
export enum MattermostChannelType {
  /** One-on-one direct message */
  DIRECT = "D",
  /** Group direct message */
  GROUP = "G",
  /** Public channel */
  OPEN = "O",
  /** Private channel */
  PRIVATE = "P",
}

/**
 * DM policy options.
 */
export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

/**
 * Group policy options.
 */
export type GroupPolicy = "allowlist" | "open" | "disabled";

/**
 * Mattermost user information.
 */
export interface MattermostUser {
  id: string;
  username?: string | null;
  nickname?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  position?: string | null;
  roles?: string | null;
  locale?: string | null;
  timezone?: Record<string, string> | null;
  is_bot?: boolean;
  bot_description?: string | null;
  create_at?: number;
  update_at?: number;
  delete_at?: number;
}

/**
 * Mattermost channel information.
 */
export interface MattermostChannel {
  id: string;
  name?: string | null;
  display_name?: string | null;
  type?: string | null;
  team_id?: string | null;
  header?: string | null;
  purpose?: string | null;
  create_at?: number;
  update_at?: number;
  delete_at?: number;
  creator_id?: string | null;
}

/**
 * Mattermost post (message) information.
 */
export interface MattermostPost {
  id: string;
  user_id?: string | null;
  channel_id?: string | null;
  message?: string | null;
  file_ids?: string[] | null;
  type?: string | null;
  root_id?: string | null;
  parent_id?: string | null;
  create_at?: number | null;
  update_at?: number | null;
  delete_at?: number | null;
  edit_at?: number | null;
  props?: Record<string, unknown> | null;
  hashtags?: string | null;
  pending_post_id?: string | null;
}

/**
 * Mattermost file information.
 */
export interface MattermostFileInfo {
  id: string;
  name?: string | null;
  mime_type?: string | null;
  size?: number | null;
  extension?: string | null;
  post_id?: string | null;
  channel_id?: string | null;
  create_at?: number;
  update_at?: number;
  delete_at?: number;
}

/**
 * Mattermost team information.
 */
export interface MattermostTeam {
  id: string;
  name?: string | null;
  display_name?: string | null;
  description?: string | null;
  type?: string | null;
  create_at?: number;
  update_at?: number;
  delete_at?: number;
}

/**
 * WebSocket event payload from Mattermost.
 */
export interface MattermostWebSocketEvent {
  event?: string;
  seq?: number;
  data?: {
    post?: string;
    channel_id?: string;
    channel_name?: string;
    channel_display_name?: string;
    channel_type?: string;
    sender_name?: string;
    team_id?: string;
    [key: string]: unknown;
  };
  broadcast?: {
    channel_id?: string;
    team_id?: string;
    user_id?: string;
    omit_users?: Record<string, boolean> | null;
  };
}

/**
 * Event payload map for Mattermost events.
 */
export interface MattermostEventPayloadMap {
  [MattermostEventTypes.MESSAGE_RECEIVED]: MattermostMessageReceivedPayload;
  [MattermostEventTypes.MESSAGE_SENT]: MattermostMessageSentPayload;
  [MattermostEventTypes.REACTION_RECEIVED]: MattermostReactionReceivedPayload;
  [MattermostEventTypes.WORLD_JOINED]: MattermostWorldPayload;
  [MattermostEventTypes.WORLD_CONNECTED]: MattermostWorldPayload;
  [MattermostEventTypes.WORLD_LEFT]: MattermostWorldPayload;
  [MattermostEventTypes.ENTITY_JOINED]: MattermostEntityPayload;
  [MattermostEventTypes.ENTITY_LEFT]: MattermostEntityPayload;
  [MattermostEventTypes.ENTITY_UPDATED]: MattermostEntityPayload;
  [MattermostEventTypes.INTERACTION_RECEIVED]: MattermostReactionReceivedPayload;
}

/**
 * Payload for a received message event.
 */
export interface MattermostMessageReceivedPayload extends MessagePayload {
  originalPost: MattermostPost;
  channel: MattermostChannel;
  user: MattermostUser | null;
}

/**
 * Payload for a sent message event.
 */
export interface MattermostMessageSentPayload extends MessagePayload {
  originalPost: MattermostPost;
  channelId: string;
}

/**
 * Payload for a reaction event.
 */
export interface MattermostReactionReceivedPayload extends MattermostMessageReceivedPayload {
  reactionString: string;
  emojiName: string;
}

/**
 * Payload describing the bot's current world/channel context.
 */
export interface MattermostWorldPayload extends WorldPayload {
  channel: MattermostChannel;
  team?: MattermostTeam | null;
  botUsername?: string;
}

/**
 * Payload describing a user-related event in a channel.
 */
export interface MattermostEntityPayload extends EntityPayload {
  mattermostUser: MattermostUser;
  channel: MattermostChannel;
}

/**
 * Helper function to get display name for a user.
 */
export function getUserDisplayName(user: MattermostUser): string {
  if (user.nickname?.trim()) {
    return user.nickname.trim();
  }
  if (user.first_name?.trim() || user.last_name?.trim()) {
    return [user.first_name?.trim(), user.last_name?.trim()].filter(Boolean).join(" ");
  }
  return user.username?.trim() || user.id;
}

/**
 * Helper function to get display name for a channel.
 */
export function getChannelDisplayName(channel: MattermostChannel): string {
  return channel.display_name?.trim() || channel.name?.trim() || channel.id;
}

/**
 * Helper function to determine channel kind from type.
 */
export function getChannelKind(channelType?: string | null): "dm" | "group" | "channel" {
  if (!channelType) {
    return "channel";
  }
  const normalized = channelType.trim().toUpperCase();
  if (normalized === "D") {
    return "dm";
  }
  if (normalized === "G") {
    return "group";
  }
  return "channel";
}

/**
 * Check if a post is a system post.
 */
export function isSystemPost(post: MattermostPost): boolean {
  const type = post.type?.trim();
  return Boolean(type);
}
