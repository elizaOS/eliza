import type { ChannelType, Metadata } from "./primitives";
import type {
  Component as ProtoComponent,
  Entity as ProtoEntity,
  Participant as ProtoParticipant,
  Relationship as ProtoRelationship,
  Room as ProtoRoom,
  World as ProtoWorld,
  WorldMetadata as ProtoWorldMetadata,
} from "./proto.js";
import type { WorldSettings } from "./settings";

export type TimestampValue = number;

export interface Component
  extends Omit<
    ProtoComponent,
    "$typeName" | "$unknown" | "createdAt" | "data"
  > {
  createdAt: TimestampValue;
  data?: Metadata;
}

/**
 * Represents a user account
 */
export interface Entity
  extends Omit<
    ProtoEntity,
    "$typeName" | "$unknown" | "metadata" | "components"
  > {
  metadata?: Metadata;
  components?: Component[];
}

/**
 * Defines roles within a system, typically for access control or permissions, often within a `World`.
 * - `OWNER`: Represents the highest level of control, typically the creator or primary administrator.
 * - `ADMIN`: Represents administrative privileges, usually a subset of owner capabilities.
 * - `NONE`: Indicates no specific role or default, minimal permissions.
 * These roles are often used in `World.metadata.roles` to assign roles to entities.
 */
export const Role = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  NONE: "NONE",
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export interface WorldOwnership {
  ownerId: string;
}

export interface WorldMetadata
  extends Omit<
    ProtoWorldMetadata,
    "$typeName" | "$unknown" | "roles" | "extra" | "ownership"
  > {
  type?: string;
  description?: string;
  ownership?: WorldOwnership;
  roles?: Record<string, Role>;
  extra?: Metadata;
  settings?: WorldSettings;
}

export interface World
  extends Omit<ProtoWorld, "$typeName" | "$unknown" | "metadata"> {
  metadata?: WorldMetadata;
}

export interface Room
  extends Omit<ProtoRoom, "$typeName" | "$unknown" | "type" | "metadata"> {
  type: ChannelType;
  metadata?: Metadata;
}

export type RoomMetadata = Metadata;

/**
 * Room participant with account details
 */
export interface Participant
  extends Omit<ProtoParticipant, "$typeName" | "$unknown" | "entity"> {
  entity: Entity;
}

/**
 * Represents a relationship between users
 */
export interface Relationship
  extends Omit<ProtoRelationship, "$typeName" | "$unknown" | "metadata"> {
  metadata?: Metadata;
}
