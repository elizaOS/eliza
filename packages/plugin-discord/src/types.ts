import type {
	BaseEventPayload,
	ChannelType,
	EventPayloadMap,
	EventTypes,
	MessageReceivedPayload,
	MessageSentPayload,
	PlatformPrefix,
	ReactionReceivedPayload,
	ReactionRemovedPayload,
	ServerPayload,
	UserJoinedPayload,
	UserLeftPayload,
	VoiceStateChangedPayload,
	Character,
	Entity,
	Memory,
	Room,
	UUID,
	World,
} from "@elizaos/core";
import type { Client, Guild, GuildMember, Message, MessageReaction, User, VoiceState } from "discord.js";

/**
 * Discord-specific event types
 */
export enum DiscordEventTypes {
	// Message events (prefixed versions of core events)
	MESSAGE_RECEIVED = "DISCORD_MESSAGE_RECEIVED",
	MESSAGE_SENT = "DISCORD_MESSAGE_SENT",
	
	// Reaction events
	REACTION_RECEIVED = "DISCORD_REACTION_RECEIVED",
	REACTION_REMOVED = "DISCORD_REACTION_REMOVED",
	
	// Server events
	SERVER_JOINED = "DISCORD_SERVER_JOINED",
	SERVER_CONNECTED = "DISCORD_SERVER_CONNECTED",
	
	// User events
	USER_JOINED = "DISCORD_USER_JOINED",
	USER_LEFT = "DISCORD_USER_LEFT",
	
	// Voice events
	VOICE_STATE_CHANGED = "DISCORD_VOICE_STATE_CHANGED",
}

/**
 * Discord-specific message received payload
 */
export interface DiscordMessageReceivedPayload extends MessageReceivedPayload {
	/** The original Discord message */
	originalMessage: Message;
}

/**
 * Discord-specific message sent payload
 */
export interface DiscordMessageSentPayload extends MessageSentPayload {
	/** The original Discord messages sent */
	originalMessages: Message[];
}

/**
 * Discord-specific reaction received payload
 */
export interface DiscordReactionReceivedPayload extends ReactionReceivedPayload {
	/** The original Discord reaction */
	originalReaction: MessageReaction;
	/** The user who reacted */
	user: User;
}

/**
 * Discord-specific reaction removed payload
 */
export interface DiscordReactionRemovedPayload extends ReactionRemovedPayload {
	/** The original Discord reaction */
	originalReaction: MessageReaction;
	/** The user who removed the reaction */
	user: User;
}

/**
 * Discord-specific server payload
 */
export interface DiscordServerPayload extends ServerPayload {
	/** The original Discord guild */
	server: Guild;
}

/**
 * Discord-specific user joined payload
 */
export interface DiscordUserJoinedPayload extends UserJoinedPayload {
	/** The original Discord guild member */
	member: GuildMember;
}

/**
 * Discord-specific user left payload
 */
export interface DiscordUserLeftPayload extends UserLeftPayload {
	/** The original Discord guild member */
	member: GuildMember;
}

/**
 * Discord-specific voice state changed payload
 */
export interface DiscordVoiceStateChangedPayload extends VoiceStateChangedPayload {
	/** The original Discord voice state */
	voiceState: VoiceState;
}

/**
 * Maps Discord event types to their payload interfaces
 */
export interface DiscordEventPayloadMap {
	[DiscordEventTypes.MESSAGE_RECEIVED]: DiscordMessageReceivedPayload;
	[DiscordEventTypes.MESSAGE_SENT]: DiscordMessageSentPayload;
	[DiscordEventTypes.REACTION_RECEIVED]: DiscordReactionReceivedPayload;
	[DiscordEventTypes.REACTION_REMOVED]: DiscordReactionRemovedPayload;
	[DiscordEventTypes.SERVER_JOINED]: DiscordServerPayload;
	[DiscordEventTypes.SERVER_CONNECTED]: DiscordServerPayload;
	[DiscordEventTypes.USER_JOINED]: DiscordUserJoinedPayload;
	[DiscordEventTypes.USER_LEFT]: DiscordUserLeftPayload;
	[DiscordEventTypes.VOICE_STATE_CHANGED]: DiscordVoiceStateChangedPayload;
}

/**
 * Interface representing a Discord service.
 *
 * @typedef {Object} IDiscordService
 * @property {Client} client - The Discord client object.
 * @property {Character} character - The character object.
 */
export interface IDiscordService {
	client: Client;
	character: Character;
}

export const ServiceTypes = {
	DISCORD: "discord",
} as const;
