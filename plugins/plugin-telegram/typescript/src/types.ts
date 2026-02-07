import type { Content, EntityPayload, MessagePayload, WorldPayload } from "@elizaos/core";
import type { Chat, Message, ReactionType, User } from "@telegraf/types";
import type { Context } from "telegraf";

export interface TelegramContent extends Content {
  buttons?: Button[];
}

export type Button = {
  kind: "login" | "url";
  text: string;
  url: string;
};

export enum TelegramEventTypes {
  WORLD_JOINED = "TELEGRAM_WORLD_JOINED",
  WORLD_CONNECTED = "TELEGRAM_WORLD_CONNECTED",
  WORLD_LEFT = "TELEGRAM_WORLD_LEFT",
  ENTITY_JOINED = "TELEGRAM_ENTITY_JOINED",
  ENTITY_LEFT = "TELEGRAM_ENTITY_LEFT",
  ENTITY_UPDATED = "TELEGRAM_ENTITY_UPDATED",
  MESSAGE_RECEIVED = "TELEGRAM_MESSAGE_RECEIVED",
  MESSAGE_SENT = "TELEGRAM_MESSAGE_SENT",
  REACTION_RECEIVED = "TELEGRAM_REACTION_RECEIVED",
  REACTION_SENT = "TELEGRAM_REACTION_SENT",
  INTERACTION_RECEIVED = "TELEGRAM_INTERACTION_RECEIVED",
  SLASH_START = "TELEGRAM_SLASH_START",
  BOT_STARTED = "TELEGRAM_BOT_STARTED",
  BOT_STOPPED = "TELEGRAM_BOT_STOPPED",
  WEBHOOK_REGISTERED = "TELEGRAM_WEBHOOK_REGISTERED",
}

export interface TelegramEventPayloadMap {
  [TelegramEventTypes.MESSAGE_RECEIVED]: TelegramMessageReceivedPayload;
  [TelegramEventTypes.MESSAGE_SENT]: TelegramMessageSentPayload;
  [TelegramEventTypes.REACTION_RECEIVED]: TelegramReactionReceivedPayload;
  [TelegramEventTypes.REACTION_SENT]: TelegramReactionSentPayload;
  [TelegramEventTypes.WORLD_JOINED]: TelegramWorldPayload;
  [TelegramEventTypes.WORLD_CONNECTED]: TelegramWorldPayload;
  [TelegramEventTypes.WORLD_LEFT]: TelegramWorldPayload;
  [TelegramEventTypes.SLASH_START]: { ctx: Context };
  [TelegramEventTypes.ENTITY_JOINED]: TelegramEntityPayload;
  [TelegramEventTypes.ENTITY_LEFT]: TelegramEntityPayload;
  [TelegramEventTypes.ENTITY_UPDATED]: TelegramEntityPayload;
  [TelegramEventTypes.INTERACTION_RECEIVED]: TelegramReactionReceivedPayload;
  [TelegramEventTypes.BOT_STARTED]: TelegramBotStatusPayload;
  [TelegramEventTypes.BOT_STOPPED]: TelegramBotStatusPayload;
  [TelegramEventTypes.WEBHOOK_REGISTERED]: TelegramWebhookPayload;
}

export interface TelegramMessageReceivedPayload extends MessagePayload {
  ctx: Context;
  originalMessage: Message;
}

export interface TelegramMessageSentPayload extends MessagePayload {
  originalMessages: Message[];
  chatId: number | string;
}

export interface TelegramReactionReceivedPayload extends TelegramMessageReceivedPayload {
  reactionString: string;
  originalReaction: ReactionType;
}

export interface TelegramReactionSentPayload {
  chatId: number | string;
  messageId: number;
  reaction: string;
  success: boolean;
}

export interface TelegramWorldPayload extends WorldPayload {
  chat: Chat;
  botUsername?: string;
}

export interface TelegramEntityPayload extends EntityPayload {
  telegramUser: {
    id: number;
    username?: string;
    first_name?: string;
  };
}

/**
 * Bot status payload for start/stop events.
 */
export interface TelegramBotStatusPayload {
  botId?: number;
  botUsername?: string;
  botName?: string;
  updateMode: "polling" | "webhook";
  timestamp: number;
}

/**
 * Webhook registration payload.
 */
export interface TelegramWebhookPayload {
  url: string;
  path: string;
  port?: number;
  hasSecret: boolean;
  timestamp: number;
}

/**
 * Bot probe result for health checks.
 */
export interface TelegramBotProbe {
  ok: boolean;
  bot?: {
    id: number;
    username?: string;
    firstName: string;
    canJoinGroups: boolean;
    canReadAllGroupMessages: boolean;
    supportsInlineQueries: boolean;
  };
  error?: string;
  latencyMs: number;
}

/**
 * Reaction emoji types supported by Telegram.
 * Common reactions that can be sent to messages.
 */
export const TELEGRAM_REACTIONS = {
  THUMBS_UP: "👍",
  THUMBS_DOWN: "👎",
  HEART: "❤",
  FIRE: "🔥",
  CELEBRATION: "🎉",
  CRYING: "😢",
  THINKING: "🤔",
  EXPLODING_HEAD: "🤯",
  SCREAMING: "😱",
  ANGRY: "🤬",
  SKULL: "💀",
  POOP: "💩",
  CLOWN: "🤡",
  QUESTION: "🤨",
  EYES: "👀",
  WHALE: "🐳",
  HEART_ON_FIRE: "❤️‍🔥",
  NEW_MOON: "🌚",
  HOT_DOG: "🌭",
  HUNDRED: "💯",
  TEARS_OF_JOY: "😂",
  LIGHTNING: "⚡",
  BANANA: "🍌",
  TROPHY: "🏆",
  BROKEN_HEART: "💔",
  FACE_WITH_RAISED_EYEBROW: "🤨",
  NEUTRAL: "😐",
  STRAWBERRY: "🍓",
  CHAMPAGNE: "🍾",
  KISS: "💋",
  MIDDLE_FINGER: "🖕",
  DEVIL: "😈",
  SLEEPING: "😴",
  LOUDLY_CRYING: "😭",
  NERD: "🤓",
  GHOST: "👻",
  TECHNOLOGIST: "👨‍💻",
  UNICORN: "🦄",
} as const;

export type TelegramReactionEmoji = (typeof TELEGRAM_REACTIONS)[keyof typeof TELEGRAM_REACTIONS];

/**
 * Send reaction parameters.
 */
export interface SendReactionParams {
  chatId: number | string;
  messageId: number;
  reaction: string | TelegramReactionEmoji;
  isBig?: boolean;
}

/**
 * Send reaction result.
 */
export interface SendReactionResult {
  success: boolean;
  chatId: number | string;
  messageId: number;
  reaction: string;
  error?: string;
}

/**
 * Extended bot info from getMe.
 */
export interface TelegramBotInfo extends User {
  can_join_groups: boolean;
  can_read_all_group_messages: boolean;
  supports_inline_queries: boolean;
}

/**
 * Edit message parameters.
 */
export interface EditMessageParams {
  chatId: number | string;
  messageId: number;
  text: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
}

/**
 * Edit message result.
 */
export interface EditMessageResult {
  success: boolean;
  chatId: number | string;
  messageId: number;
  error?: string;
}

/**
 * Delete message parameters.
 */
export interface DeleteMessageParams {
  chatId: number | string;
  messageId: number;
}

/**
 * Delete message result.
 */
export interface DeleteMessageResult {
  success: boolean;
  chatId: number | string;
  messageId: number;
  error?: string;
}

/**
 * Send sticker parameters.
 */
export interface SendStickerParams {
  chatId: number | string;
  sticker: string; // file_id, URL, or file path
  replyToMessageId?: number;
  threadId?: number;
  disableNotification?: boolean;
}

/**
 * Send sticker result.
 */
export interface SendStickerResult {
  success: boolean;
  chatId: number | string;
  messageId?: number;
  error?: string;
}
