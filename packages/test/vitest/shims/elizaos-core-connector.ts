export type * from "../../../core/src/connectors/account-manager.ts";

import { createHash } from "node:crypto";

// Real (unstubbed) HTTP + state-dir + route-context helpers. Plugin route-e2e
// tests boot the genuine runtime-plugin-route dispatcher, which imports these
// from "@elizaos/core"; the dispatcher's behavior is under test, so these must
// be the real implementations, not stubs.
export {
  isJsonObjectBody,
  readRequestBodyBuffer,
  writeJsonError,
} from "../../../core/src/api/http-helpers.ts";
export {
  CONNECTOR_ACCOUNT_SERVICE_TYPE,
  CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
  getConnectorAccountManager,
  resetConnectorAccountManagerForTests,
} from "../../../core/src/connectors/account-manager.ts";
export { readRequestedConnectorRole } from "../../../core/src/connectors/oauth-role.ts";
export {
  type RuntimeRouteHostContext,
  setRuntimeRouteHostContext,
} from "../../../core/src/runtime-route-context.ts";
export type {
  IAgentRuntime,
  PaymentEnabledRoute,
  Plugin,
  Route,
} from "../../../core/src/types/index.ts";
export { Service } from "../../../core/src/types/service.ts";
export { resolveSetting } from "../../../core/src/utils/resolve-setting.ts";
export { resolveStateDir } from "../../../core/src/utils/state-dir.ts";

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

export function runWithTrajectoryContext<T>(
  _context: unknown,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return fn();
}

export function runWithTrajectoryPurpose<T>(
  _purpose: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return fn();
}

export function resolveOptimizedPromptForRuntime(
  runtime: {
    getService?: (name: string) => {
      getPrompt?: (task: string) => { prompt?: string } | null;
    } | null;
  },
  task: string,
  baseline: string,
): string {
  return (
    runtime
      .getService?.("optimized_prompt")
      ?.getPrompt?.(task)
      ?.prompt?.trim() || baseline
  );
}
