import type {
  Content,
  EntityPayload,
  MessagePayload,
  WorldPayload,
} from "@elizaos/core";

/**
 * Extended content type for Tlon messages
 */
export interface TlonContent extends Content {
  /** The ship that sent the message */
  ship?: string;
  /** Channel nest for group messages */
  channelNest?: string;
  /** Parent message ID for thread replies */
  replyToId?: string;
}

/**
 * Event types emitted by the Tlon plugin
 */
export enum TlonEventTypes {
  WORLD_JOINED = "TLON_WORLD_JOINED",
  WORLD_CONNECTED = "TLON_WORLD_CONNECTED",
  WORLD_LEFT = "TLON_WORLD_LEFT",
  ENTITY_JOINED = "TLON_ENTITY_JOINED",
  ENTITY_LEFT = "TLON_ENTITY_LEFT",
  MESSAGE_RECEIVED = "TLON_MESSAGE_RECEIVED",
  MESSAGE_SENT = "TLON_MESSAGE_SENT",
  DM_RECEIVED = "TLON_DM_RECEIVED",
  GROUP_MESSAGE_RECEIVED = "TLON_GROUP_MESSAGE_RECEIVED",
  CONNECTION_ERROR = "TLON_CONNECTION_ERROR",
  RECONNECTED = "TLON_RECONNECTED",
}

/**
 * Tlon channel types
 */
export enum TlonChannelType {
  DM = "dm",
  GROUP = "group",
  THREAD = "thread",
}

/**
 * Urbit ship information
 */
export interface TlonShip {
  /** Ship name (without ~) */
  name: string;
  /** Display name if available */
  displayName?: string;
  /** Ship avatar URL */
  avatar?: string;
}

/**
 * Tlon chat/channel information
 */
export interface TlonChat {
  /** Channel identifier (ship for DM, nest for groups) */
  id: string;
  /** Channel type */
  type: TlonChannelType;
  /** Channel name/title */
  name?: string;
  /** Host ship for group channels */
  hostShip?: string;
  /** Channel description */
  description?: string;
}

/**
 * Payload for received messages
 */
export interface TlonMessagePayload extends MessagePayload {
  /** The message ID */
  messageId: string;
  /** The chat where the message was received */
  chat: TlonChat;
  /** The sender ship */
  fromShip: TlonShip;
  /** Message text content */
  text: string;
  /** Timestamp (ms since epoch) */
  timestamp: number;
  /** Parent message ID for thread replies */
  replyToId?: string;
  /** Raw memo content from Urbit */
  rawContent?: unknown;
}

/**
 * Payload for sent messages
 */
export interface TlonMessageSentPayload extends MessagePayload {
  /** The message ID */
  messageId: string;
  /** Target chat */
  chat: TlonChat;
  /** Message text */
  text: string;
  /** Whether it was a reply */
  isReply: boolean;
}

/**
 * Payload for world/connection events
 */
export interface TlonWorldPayload extends WorldPayload {
  /** The connected ship */
  ship: TlonShip;
  /** Available DM conversations */
  dmConversations?: string[];
  /** Available group channels */
  groupChannels?: string[];
}

/**
 * Payload for entity (ship) events
 */
export interface TlonEntityPayload extends EntityPayload {
  /** The ship involved */
  ship: TlonShip;
  /** The chat context */
  chat: TlonChat;
  /** Action type */
  action: "joined" | "left" | "updated";
}

/**
 * Event payload map for type safety
 */
export interface TlonEventPayloadMap {
  [TlonEventTypes.MESSAGE_RECEIVED]: TlonMessagePayload;
  [TlonEventTypes.MESSAGE_SENT]: TlonMessageSentPayload;
  [TlonEventTypes.DM_RECEIVED]: TlonMessagePayload;
  [TlonEventTypes.GROUP_MESSAGE_RECEIVED]: TlonMessagePayload;
  [TlonEventTypes.WORLD_JOINED]: TlonWorldPayload;
  [TlonEventTypes.WORLD_CONNECTED]: TlonWorldPayload;
  [TlonEventTypes.WORLD_LEFT]: TlonWorldPayload;
  [TlonEventTypes.ENTITY_JOINED]: TlonEntityPayload;
  [TlonEventTypes.ENTITY_LEFT]: TlonEntityPayload;
  [TlonEventTypes.CONNECTION_ERROR]: { error: Error; willRetry: boolean };
  [TlonEventTypes.RECONNECTED]: { attempt: number };
}

/**
 * Authorization rule for a channel
 */
export interface TlonChannelRule {
  /** Authorization mode */
  mode: "restricted" | "open";
  /** List of ships allowed when in restricted mode */
  allowedShips?: string[];
}

/**
 * Plugin authorization configuration
 */
export interface TlonAuthorization {
  /** Rules by channel nest */
  channelRules?: Record<string, TlonChannelRule>;
  /** Default allowed ships for all channels */
  defaultAuthorizedShips?: string[];
}

/**
 * Message content as sent/received from Urbit
 */
export interface TlonMemo {
  content: TlonStory;
  author: string;
  sent: number;
}

/**
 * Story content (array of verse elements)
 */
export type TlonStory = TlonVerse[];

/**
 * Verse element (inline content)
 */
export interface TlonVerse {
  inline?: TlonInline[];
  block?: TlonBlock;
}

/**
 * Inline content types
 */
export type TlonInline = string | TlonInlineElement;

/**
 * Inline element types (links, mentions, etc.)
 */
export interface TlonInlineElement {
  ship?: string;
  link?: { href: string; content: string };
  bold?: TlonInline[];
  italic?: TlonInline[];
  strike?: TlonInline[];
  code?: string;
  blockquote?: TlonInline[];
}

/**
 * Block content types (images, code blocks, etc.)
 */
export interface TlonBlock {
  image?: { src: string; alt?: string; width?: number; height?: number };
  code?: { code: string; lang?: string };
  header?: { content: TlonInline[]; tag: "h1" | "h2" | "h3" };
  listing?: { type: "ordered" | "unordered"; items: TlonInline[][] };
  rule?: boolean;
}

/**
 * Subscription information
 */
export interface TlonSubscription {
  id: number;
  app: string;
  path: string;
}
