import type {
  BaseEventPayload,
  ChannelType,
  EventTypes,
  MessageReceivedPayload,
  MessageSentPayload,
  ReactionReceivedPayload,
  ServerPayload,
  UserJoinedPayload,
  UserLeftPayload,
  Memory,
  UUID,
} from "@elizaos/core";
import type { Chat, Message, ReactionType, Update } from "@telegraf/types";
import type { Context, NarrowedContext } from "telegraf";

/**
 * Telegram-specific event types
 */
export enum TelegramEventTypes {
  // Message events
  MESSAGE_RECEIVED = "TELEGRAM_MESSAGE_RECEIVED",
  MESSAGE_SENT = "TELEGRAM_MESSAGE_SENT",
  
  // Reaction events
  REACTION_RECEIVED = "TELEGRAM_REACTION_RECEIVED",
  
  // Server events
  SERVER_JOINED = "TELEGRAM_SERVER_JOINED",
  SERVER_CONNECTED = "TELEGRAM_SERVER_CONNECTED",
  
  // User events
  USER_JOINED = "TELEGRAM_USER_JOINED",
  USER_LEFT = "TELEGRAM_USER_LEFT",
}

/**
 * Telegram-specific message received payload
 */
export interface TelegramMessageReceivedPayload extends MessageReceivedPayload {
  /** The original Telegram context */
  ctx: Context;
  /** The original Telegram message */
  originalMessage: Message;
}

/**
 * Telegram-specific message sent payload
 */
export interface TelegramMessageSentPayload extends MessageSentPayload {
  /** The original Telegram messages */
  originalMessages: Message.TextMessage[];
  /** The chat ID where the message was sent */
  chatId: number | string;
}

/**
 * Telegram-specific reaction received payload
 */
export interface TelegramReactionReceivedPayload extends ReactionReceivedPayload {
  /** The original Telegram context */
  ctx: NarrowedContext<Context<Update>, Update.MessageReactionUpdate>;
  /** The reaction type as a string */
  reactionString: string;
  /** The original reaction object */
  originalReaction: ReactionType;
}

/**
 * Telegram-specific server joined/connected payload
 */
export interface TelegramServerPayload extends ServerPayload {
  /** The original Telegram chat */
  chat: Chat;
}

/**
 * Telegram-specific user joined payload
 */
export interface TelegramUserJoinedPayload extends UserJoinedPayload {
  /** The original Telegram user */
  telegramUser: {
    id: number;
    username?: string;
    first_name?: string;
  };
}

/**
 * Telegram-specific user left payload
 */
export interface TelegramUserLeftPayload extends UserLeftPayload {
  /** The original Telegram user */
  telegramUser: {
    id: number;
    username?: string;
    first_name?: string;
  };
}

/**
 * Maps Telegram event types to their payload interfaces
 */
export interface TelegramEventPayloadMap {
  [TelegramEventTypes.MESSAGE_RECEIVED]: TelegramMessageReceivedPayload;
  [TelegramEventTypes.MESSAGE_SENT]: TelegramMessageSentPayload;
  [TelegramEventTypes.REACTION_RECEIVED]: TelegramReactionReceivedPayload;
  [TelegramEventTypes.SERVER_JOINED]: TelegramServerPayload;
  [TelegramEventTypes.SERVER_CONNECTED]: TelegramServerPayload;
  [TelegramEventTypes.USER_JOINED]: TelegramUserJoinedPayload;
  [TelegramEventTypes.USER_LEFT]: TelegramUserLeftPayload;
} 