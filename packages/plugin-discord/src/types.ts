import type { Character, EntityPayload, MessagePayload, WorldPayload } from '@elizaos/core';
import type {
  Client as DiscordJsClient,
  Guild,
  GuildMember,
  Message,
  MessageReaction,
  User,
  VoiceState,
} from 'discord.js';

/**
 * Discord-specific event types
 */
export enum DiscordEventTypes {
  // Message events (prefixed versions of core events)
  MESSAGE_RECEIVED = 'DISCORD_MESSAGE_RECEIVED',
  MESSAGE_SENT = 'DISCORD_MESSAGE_SENT',

  // Reaction events
  REACTION_RECEIVED = 'DISCORD_REACTION_RECEIVED',
  REACTION_REMOVED = 'DISCORD_REACTION_REMOVED',

  // Server events
  WORLD_JOINED = 'DISCORD_WORLD_JOINED',
  WORLD_CONNECTED = 'DISCORD_SERVER_CONNECTED',

  // User events
  ENTITY_JOINED = 'DISCORD_USER_JOINED',
  ENTITY_LEFT = 'DISCORD_USER_LEFT',

  // Voice events
  VOICE_STATE_CHANGED = 'DISCORD_VOICE_STATE_CHANGED',
}

/**
 * Discord-specific message received payload
 */
export interface DiscordMessageReceivedPayload extends MessagePayload {
  /** The original Discord message */
  originalMessage: Message;
}

/**
 * Discord-specific message sent payload
 */
export interface DiscordMessageSentPayload extends MessagePayload {
  /** The original Discord messages sent */
  originalMessages: Message[];
}

/**
 * Discord-specific reaction received payload
 */
export interface DiscordReactionPayload extends MessagePayload {
  /** The original Discord reaction */
  originalReaction: MessageReaction;
  /** The user who reacted */
  user: User;
}
/**
 * Discord-specific server payload
 */
export interface DiscordServerPayload extends WorldPayload {
  /** The original Discord guild */
  server: Guild;
}

/**
 * Discord-specific user joined payload
 */
export interface DiscordUserJoinedPayload extends EntityPayload {
  /** The original Discord guild member */
  member: GuildMember;
}

/**
 * Discord-specific user left payload
 */
export interface DiscordUserLeftPayload extends EntityPayload {
  /** The original Discord guild member */
  member: GuildMember;
}

/**
 * Discord-specific voice state changed payload
 */
export interface DiscordVoiceStateChangedPayload {
  /** The original Discord voice state */
  voiceState: VoiceState;
}

/**
 * Maps Discord event types to their payload interfaces
 */
export interface DiscordEventPayloadMap {
  [DiscordEventTypes.MESSAGE_RECEIVED]: DiscordMessageReceivedPayload;
  [DiscordEventTypes.MESSAGE_SENT]: DiscordMessageSentPayload;
  [DiscordEventTypes.REACTION_RECEIVED]: DiscordReactionPayload;
  [DiscordEventTypes.REACTION_REMOVED]: DiscordReactionPayload;
  [DiscordEventTypes.WORLD_JOINED]: DiscordServerPayload;
  [DiscordEventTypes.WORLD_CONNECTED]: DiscordServerPayload;
  [DiscordEventTypes.ENTITY_JOINED]: DiscordUserJoinedPayload;
  [DiscordEventTypes.ENTITY_LEFT]: DiscordUserLeftPayload;
  [DiscordEventTypes.VOICE_STATE_CHANGED]: DiscordVoiceStateChangedPayload;
}

/**
 * Interface representing a Discord service.
 *
 * @typedef {Object} IDiscordService
 * @property {DiscordJsClient} client - The Discord client object.
 * @property {Character} character - The character object.
 */
export interface IDiscordService {
  client: DiscordJsClient;
  character: Character;
}

export const DISCORD_SERVICE_NAME = 'discord';

export const ServiceType = {
  DISCORD: 'discord',
} as const;
