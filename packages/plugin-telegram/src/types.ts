import type { Content, EntityPayload, MessagePayload, WorldPayload } from '@elizaos/core';
import type { Chat, Message, ReactionType } from '@telegraf/types';
import type { Context } from 'telegraf';

/**
 * Extention of the core Content type just for Telegram
 */
export interface TelegramContent extends Content {
  /** Array of buttons */
  buttons?: Button[];
}

/**
 * Represents a flexible button configuration
 */
export type Button = {
  /** The type of button */
  kind: 'login' | 'url';
  /** The text to display on the button */
  text: string;
  /** The URL or endpoint the button should link to */
  url: string;
};

/**
 * Telegram-specific event types
 */
export enum TelegramEventTypes {
  // World events
  WORLD_JOINED = 'TELEGRAM_WORLD_JOINED',
  WORLD_CONNECTED = 'TELEGRAM_WORLD_CONNECTED',
  WORLD_LEFT = 'TELEGRAM_WORLD_LEFT',

  // Entity events
  ENTITY_JOINED = 'TELEGRAM_ENTITY_JOINED',
  ENTITY_LEFT = 'TELEGRAM_ENTITY_LEFT',
  ENTITY_UPDATED = 'TELEGRAM_ENTITY_UPDATED',

  // Message events
  MESSAGE_RECEIVED = 'TELEGRAM_MESSAGE_RECEIVED',
  MESSAGE_SENT = 'TELEGRAM_MESSAGE_SENT',

  // Interaction events
  REACTION_RECEIVED = 'TELEGRAM_REACTION_RECEIVED',
  INTERACTION_RECEIVED = 'TELEGRAM_INTERACTION_RECEIVED',
}

/**
 * Telegram-specific message received payload
 */
export interface TelegramMessageReceivedPayload extends MessagePayload {
  /** The original Telegram context */
  ctx: Context;
  /** The original Telegram message */
  originalMessage: Message;
}

/**
 * Telegram-specific message sent payload
 */
export interface TelegramMessageSentPayload extends MessagePayload {
  /** The original Telegram messages */
  originalMessages: Message[];
  /** The chat ID where the message was sent */
  chatId: number | string;
}

/**
 * Telegram-specific reaction received payload
 */
export interface TelegramReactionReceivedPayload extends TelegramMessageReceivedPayload {
  /** The reaction type as a string */
  reactionString: string;
  /** The original reaction object */
  originalReaction: ReactionType;
}

/**
 * Telegram-specific world payload
 */
export interface TelegramWorldPayload extends WorldPayload {
  chat: Chat;
  botUsername?: string;
}

/**
 * Telegram-specific entity payload
 */
export interface TelegramEntityPayload extends EntityPayload {
  telegramUser: {
    id: number;
    username?: string;
    first_name?: string;
  };
}

/**
 * Maps Telegram event types to their corresponding payload types
 */
export interface TelegramEventPayloadMap {
  [TelegramEventTypes.MESSAGE_RECEIVED]: TelegramMessageReceivedPayload;
  [TelegramEventTypes.MESSAGE_SENT]: TelegramMessageSentPayload;
  [TelegramEventTypes.REACTION_RECEIVED]: TelegramReactionReceivedPayload;
  [TelegramEventTypes.WORLD_JOINED]: TelegramWorldPayload;
  [TelegramEventTypes.WORLD_CONNECTED]: TelegramWorldPayload;
  [TelegramEventTypes.WORLD_LEFT]: TelegramWorldPayload;
  [TelegramEventTypes.ENTITY_JOINED]: TelegramEntityPayload;
  [TelegramEventTypes.ENTITY_LEFT]: TelegramEntityPayload;
  [TelegramEventTypes.ENTITY_UPDATED]: TelegramEntityPayload;
  [TelegramEventTypes.INTERACTION_RECEIVED]: TelegramReactionReceivedPayload;
}
