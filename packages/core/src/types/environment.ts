import type { ChannelType, Metadata, UUID } from "./primitives";
import type { WorldSettings } from "./settings";

export type TimestampValue = number;

export interface Component {
	id: UUID;
	entityId: UUID;
	agentId: UUID;
	roomId: UUID;
	worldId: UUID;
	sourceEntityId: UUID;
	type: string;
	createdAt: TimestampValue;
	data?: Metadata;
}

/**
 * Represents a user account / entity.
 */
export interface Entity {
	/** Unique identifier, optional on creation */
	id?: UUID;
	/** Names of the entity */
	names: string[];
	/** Additional metadata */
	metadata?: Metadata;
	/** Agent ID this entity is related to */
	agentId: UUID;
	/** Optional array of components */
	components?: Component[];
}

/**
 * Defines roles within a system, typically for access control or permissions, often within a `World`.
 */
export const Role = {
	OWNER: "OWNER",
	ADMIN: "ADMIN",
	MEMBER: "MEMBER",
	GUEST: "GUEST",
	NONE: "NONE",
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export interface WorldOwnership {
	ownerId: string;
}

export interface WorldMetadata {
	type?: string;
	description?: string;
	ownership?: WorldOwnership;
	roles?: Record<string, Role>;
	extra?: Metadata;
	settings?: WorldSettings;
	/** Platform-specific chat type (e.g., 'private', 'group', 'supergroup', 'channel') */
	chatType?: string;
	/** Whether Telegram forum mode is enabled for this world */
	isForumEnabled?: boolean;
	/** Allow platform-specific extensions */
	[key: string]: unknown;
}

export interface World {
	id: UUID;
	name?: string;
	agentId: UUID;
	messageServerId?: UUID;
	metadata?: WorldMetadata;
}

export interface Room {
	id: UUID;
	name?: string;
	agentId?: UUID;
	source: string;
	type: ChannelType;
	channelId?: string;
	messageServerId?: UUID;
	worldId?: UUID;
	metadata?: Metadata;
	/** Platform server/guild/chat ID that owns this room */
	serverId?: string;
}

export type RoomMetadata = Metadata;

/**
 * Room participant with account details
 */
export interface Participant {
	id: UUID;
	entity: Entity;
}

/**
 * Represents a relationship between users
 */
export interface Relationship {
	id: UUID;
	sourceEntityId: UUID;
	targetEntityId: UUID;
	agentId: UUID;
	tags: string[];
	metadata?: Metadata;
	createdAt?: string;
}

// Re-export Metadata for convenience
export type { Metadata };
