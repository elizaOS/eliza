import type { UUID } from "@elizaos/core";

export const ROBLOX_SERVICE_NAME = "roblox";
export const ROBLOX_SOURCE = "roblox";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonValueOrUndefined = JsonValue | undefined;

export interface RobloxConfig {
  apiKey: string;
  universeId: string;
  placeId?: string;
  webhookSecret?: string;
  messagingTopic: string;
  pollInterval: number;
  dryRun: boolean;
}

export interface RobloxUser {
  id: number;
  username: string;
  displayName: string;
  avatarUrl?: string;
  createdAt?: Date;
  isBanned?: boolean;
}

export interface RobloxPlayerSession {
  user: RobloxUser;
  jobId: string;
  placeId: string;
  joinedAt: Date;
}

export interface RobloxGameMessage {
  id: string;
  user: RobloxUser;
  content: string;
  jobId: string;
  placeId: string;
  timestamp: Date;
  context?: Record<string, string>;
}

export interface RobloxResponse {
  content: string;
  action?: RobloxGameAction;
  flagged?: boolean;
}

export interface RobloxGameAction {
  name: string;
  parameters: Record<string, string | number | boolean | null>;
  targetPlayerIds?: number[];
}

export interface DataStoreEntry<T = JsonValue> {
  key: string;
  value: T;
  version: string;
  createdAt: Date;
  updatedAt: Date;
}

export type MessagingServiceDataValue = JsonValueOrUndefined;

export interface MessagingServiceMessage {
  topic: string;
  data: Record<string, MessagingServiceDataValue>;
  sender?: {
    agentId: UUID;
    agentName: string;
  };
}

export enum RobloxEventType {
  PLAYER_JOINED = "roblox:player_joined",
  PLAYER_LEFT = "roblox:player_left",
  PLAYER_MESSAGE = "roblox:player_message",
  GAME_EVENT = "roblox:game_event",
  WEBHOOK_RECEIVED = "roblox:webhook_received",
}

export interface RobloxEventTypes {
  [RobloxEventType.PLAYER_JOINED]: {
    session: RobloxPlayerSession;
  };
  [RobloxEventType.PLAYER_LEFT]: {
    session: RobloxPlayerSession;
    duration: number;
  };
  [RobloxEventType.PLAYER_MESSAGE]: {
    message: RobloxGameMessage;
  };
  [RobloxEventType.GAME_EVENT]: {
    eventName: string;
    data: Record<string, string | number | boolean | null>;
    triggeredBy?: RobloxUser;
  };
  [RobloxEventType.WEBHOOK_RECEIVED]: {
    type: string;
    payload: Record<string, string | number | boolean | null>;
  };
}

export interface RobloxServerInfo {
  jobId: string;
  placeId: string;
  playerCount: number;
  maxPlayers: number;
  region?: string;
  uptime?: number;
}

export interface RobloxExperienceInfo {
  universeId: string;
  name: string;
  description?: string;
  creator: {
    id: number;
    type: "User" | "Group";
    name: string;
  };
  playing?: number;
  visits?: number;
  rootPlaceId: string;
}

export type ManagerHealthStatus =
  | {
      status: "healthy";
      universeId: string;
      experienceName: string;
      playing?: number;
    }
  | {
      status: "unhealthy";
      error: string;
    };
