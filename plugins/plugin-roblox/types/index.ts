import type { UUID } from "@elizaos/core";

export const ROBLOX_SERVICE_NAME = "roblox";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonValueOrUndefined = JsonValue | undefined;

export interface RobloxConfig {
  apiKey: string;
  universeId: string;
  placeId?: string;
  webhookSecret?: string;
  messagingTopic: string;
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

type MessagingServiceDataValue = JsonValueOrUndefined;

export interface MessagingServiceMessage {
  topic: string;
  data: Record<string, MessagingServiceDataValue>;
  sender?: {
    agentId: UUID;
    agentName: string;
  };
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
