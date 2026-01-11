/**
 * Type definitions for @elizaos/plugin-roblox
 */

import type { UUID } from "@elizaos/core";

/**
 * Service name constant for registration
 */
export const ROBLOX_SERVICE_NAME = "roblox";

/**
 * Source identifier for messages
 */
export const ROBLOX_SOURCE = "roblox";

/**
 * Configuration for the Roblox plugin
 */
export interface RobloxConfig {
  /** API key for Roblox Open Cloud API */
  apiKey: string;
  /** Universe ID of the experience */
  universeId: string;
  /** Optional Place ID */
  placeId?: string;
  /** Webhook secret for validation */
  webhookSecret?: string;
  /** Messaging service topic */
  messagingTopic: string;
  /** Polling interval in seconds */
  pollInterval: number;
  /** Dry run mode */
  dryRun: boolean;
}

/**
 * Roblox user information
 */
export interface RobloxUser {
  /** Roblox user ID */
  id: number;
  /** Roblox username */
  username: string;
  /** Display name */
  displayName: string;
  /** Avatar thumbnail URL */
  avatarUrl?: string;
  /** Account creation date */
  createdAt?: Date;
  /** Whether account is banned */
  isBanned?: boolean;
}

/**
 * Roblox player session in a game
 */
export interface RobloxPlayerSession {
  /** Player user info */
  user: RobloxUser;
  /** Server job ID */
  jobId: string;
  /** Place ID the player is in */
  placeId: string;
  /** When the player joined */
  joinedAt: Date;
}

/**
 * Message from a Roblox game
 */
export interface RobloxGameMessage {
  /** Unique message ID */
  id: string;
  /** Sending user */
  user: RobloxUser;
  /** Message content */
  content: string;
  /** Server job ID */
  jobId: string;
  /** Place ID */
  placeId: string;
  /** Message timestamp */
  timestamp: Date;
  /** Optional context data */
  context?: Record<string, string>;
}

/**
 * Response to send back to Roblox
 */
export interface RobloxResponse {
  /** Response content */
  content: string;
  /** Optional action to trigger in-game */
  action?: RobloxGameAction;
  /** Whether the message was flagged */
  flagged?: boolean;
}

/**
 * Game action to execute in Roblox
 */
export interface RobloxGameAction {
  /** Action name/type */
  name: string;
  /** Action parameters */
  parameters: Record<string, unknown>;
  /** Target player IDs (empty = all) */
  targetPlayerIds?: number[];
}

/**
 * Data store entry
 */
export interface DataStoreEntry<T = unknown> {
  /** Entry key */
  key: string;
  /** Entry value */
  value: T;
  /** Entry version */
  version: string;
  /** Creation timestamp */
  createdAt: Date;
  /** Last update timestamp */
  updatedAt: Date;
}

/**
 * Messaging service message
 */
export interface MessagingServiceMessage {
  /** Topic name */
  topic: string;
  /** Message data */
  data: unknown;
  /** Sender information */
  sender?: {
    agentId: UUID;
    agentName: string;
  };
}

/**
 * Roblox event types
 */
export enum RobloxEventType {
  /** Player joined the game */
  PLAYER_JOINED = "roblox:player_joined",
  /** Player left the game */
  PLAYER_LEFT = "roblox:player_left",
  /** Player sent a chat message */
  PLAYER_MESSAGE = "roblox:player_message",
  /** Player triggered a game event */
  GAME_EVENT = "roblox:game_event",
  /** Webhook received */
  WEBHOOK_RECEIVED = "roblox:webhook_received",
}

/**
 * Roblox event payload types
 */
export interface RobloxEventTypes {
  [RobloxEventType.PLAYER_JOINED]: {
    session: RobloxPlayerSession;
  };
  [RobloxEventType.PLAYER_LEFT]: {
    session: RobloxPlayerSession;
    duration: number; // seconds played
  };
  [RobloxEventType.PLAYER_MESSAGE]: {
    message: RobloxGameMessage;
  };
  [RobloxEventType.GAME_EVENT]: {
    eventName: string;
    data: Record<string, unknown>;
    triggeredBy?: RobloxUser;
  };
  [RobloxEventType.WEBHOOK_RECEIVED]: {
    type: string;
    payload: unknown;
  };
}

/**
 * Server information
 */
export interface RobloxServerInfo {
  /** Job ID */
  jobId: string;
  /** Place ID */
  placeId: string;
  /** Current player count */
  playerCount: number;
  /** Maximum players */
  maxPlayers: number;
  /** Server region */
  region?: string;
  /** Server uptime in seconds */
  uptime?: number;
}

/**
 * Experience/Universe information
 */
export interface RobloxExperienceInfo {
  /** Universe ID */
  universeId: string;
  /** Experience name */
  name: string;
  /** Description */
  description?: string;
  /** Creator info */
  creator: {
    id: number;
    type: "User" | "Group";
    name: string;
  };
  /** Current active player count */
  playing?: number;
  /** Total visits */
  visits?: number;
  /** Root place ID */
  rootPlaceId: string;
}
