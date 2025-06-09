import type { Metadata, UUID } from './primitives';

export interface Component {
  id: UUID;
  entityId: UUID;
  agentId: UUID;
  roomId: UUID;
  worldId: UUID;
  sourceEntityId: UUID;
  type: string;
  createdAt: number;
  data: Metadata;
}

/**
 * Represents a user account
 */
export interface Entity {
  /** Unique identifier, optional on creation */
  id?: UUID;

  /** Names of the entity */
  names: string[];

  /** Optional additional metadata */
  metadata?: Metadata;

  /** Agent ID this account is related to, for agents should be themselves */
  agentId: UUID;

  /** Optional array of components */
  components?: Component[];
}

/**
 * Defines roles within a system, typically for access control or permissions, often within a `World`.
 * - `OWNER`: Represents the highest level of control, typically the creator or primary administrator.
 * - `ADMIN`: Represents administrative privileges, usually a subset of owner capabilities.
 * - `NONE`: Indicates no specific role or default, minimal permissions.
 * These roles are often used in `World.metadata.roles` to assign roles to entities.
 */
export enum Role {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  NONE = 'NONE',
}

export type World = {
  id: UUID;
  name?: string;
  agentId: UUID;
  serverId: string;
  metadata?: {
    ownership?: {
      ownerId: string;
    };
    roles?: {
      [entityId: UUID]: Role;
    };
    [key: string]: unknown;
  };
};

export enum ChannelType {
  SELF = 'SELF', // Messages to self
  DM = 'DM', // Direct messages between two participants
  GROUP = 'GROUP', // Group messages with multiple participants
  VOICE_DM = 'VOICE_DM', // Voice direct messages
  VOICE_GROUP = 'VOICE_GROUP', // Voice channels with multiple participants
  FEED = 'FEED', // Social media feed
  THREAD = 'THREAD', // Threaded conversation
  WORLD = 'WORLD', // World channel
  FORUM = 'FORUM', // Forum discussion
  // Legacy types - kept for backward compatibility but should be replaced
  API = 'API', // @deprecated - Use DM or GROUP instead
}

export type Room = {
  id: UUID;
  name?: string;
  agentId?: UUID;
  source: string;
  type: ChannelType;
  channelId?: string;
  serverId?: string;
  worldId?: UUID;
  metadata?: Metadata;
};

export type RoomMetadata = {
  [key: string]: unknown;
};

/**
 * Room participant with account details
 */
export interface Participant {
  /** Unique identifier */
  id: UUID;

  /** Associated account */
  entity: Entity;
}

/**
 * Represents a relationship between users
 */
export interface Relationship {
  /** Unique identifier */
  id: UUID;

  /** First user ID */
  sourceEntityId: UUID;

  /** Second user ID */
  targetEntityId: UUID;

  /** Agent ID */
  agentId: UUID;

  /** Tags for filtering/categorizing relationships */
  tags: string[];

  /** Additional metadata about the relationship */
  metadata: Metadata;

  /** Optional creation timestamp */
  createdAt?: string;
}
