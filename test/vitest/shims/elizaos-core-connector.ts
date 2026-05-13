export type * from "../../../packages/core/src/connectors/account-manager.ts";

import { createHash } from "node:crypto";

export {
  CONNECTOR_ACCOUNT_SERVICE_TYPE,
  CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
  getConnectorAccountManager,
  resetConnectorAccountManagerForTests,
} from "../../../packages/core/src/connectors/account-manager.ts";
export type {
  IAgentRuntime,
  Plugin,
} from "../../../packages/core/src/types/index.ts";
export { Service } from "../../../packages/core/src/types/service.ts";

type LogFn = (...args: unknown[]) => void;

const noop: LogFn = () => undefined;

export const logger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
};

export const elizaLogger = logger;

export const ChannelType = {
  SELF: "SELF",
  DM: "DM",
  GROUP: "GROUP",
  VOICE_DM: "VOICE_DM",
  VOICE_GROUP: "VOICE_GROUP",
  FEED: "FEED",
  THREAD: "THREAD",
  WORLD: "WORLD",
  FORUM: "FORUM",
  API: "API",
} as const;

export const EventType = {
  REACTION_RECEIVED: "REACTION_RECEIVED",
  POST_GENERATED: "POST_GENERATED",
  INTERACTION_RECEIVED: "INTERACTION_RECEIVED",
  MESSAGE_RECEIVED: "MESSAGE_RECEIVED",
  MESSAGE_SENT: "MESSAGE_SENT",
} as const;

export const ModelType = {
  TEXT_SMALL: "TEXT_SMALL",
  TEXT_EMBEDDING: "TEXT_EMBEDDING",
  IMAGE_DESCRIPTION: "IMAGE_DESCRIPTION",
} as const;

export function stringToUuid(value: string): string {
  const hex = createHash("sha1").update(value).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80)
      .toString(16)
      .padStart(2, "0")}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export function createUniqueUuid(
  runtime: { agentId: string },
  baseUserId: string,
): string {
  return baseUserId === runtime.agentId
    ? runtime.agentId
    : stringToUuid(`${baseUserId}:${runtime.agentId}`);
}

export function parseBooleanFromText(
  value: unknown,
  fallback = false,
): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export async function withStandaloneTrajectory<T>(
  _runtime: unknown,
  _label: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  return await fn();
}
