import type { Content, EntityPayload, MessagePayload, WorldPayload } from "@elizaos/core";
import type { Chat, Message, ReactionType } from "@telegraf/types";
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
  INTERACTION_RECEIVED = "TELEGRAM_INTERACTION_RECEIVED",
  SLASH_START = "TELEGRAM_SLASH_START",
}

export interface TelegramEventPayloadMap {
  [TelegramEventTypes.MESSAGE_RECEIVED]: TelegramMessageReceivedPayload;
  [TelegramEventTypes.MESSAGE_SENT]: TelegramMessageSentPayload;
  [TelegramEventTypes.REACTION_RECEIVED]: TelegramReactionReceivedPayload;
  [TelegramEventTypes.WORLD_JOINED]: TelegramWorldPayload;
  [TelegramEventTypes.WORLD_CONNECTED]: TelegramWorldPayload;
  [TelegramEventTypes.WORLD_LEFT]: TelegramWorldPayload;
  [TelegramEventTypes.SLASH_START]: { ctx: Context };
  [TelegramEventTypes.ENTITY_JOINED]: TelegramEntityPayload;
  [TelegramEventTypes.ENTITY_LEFT]: TelegramEntityPayload;
  [TelegramEventTypes.ENTITY_UPDATED]: TelegramEntityPayload;
  [TelegramEventTypes.INTERACTION_RECEIVED]: TelegramReactionReceivedPayload;
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
