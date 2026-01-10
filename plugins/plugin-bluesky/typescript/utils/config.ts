/**
 * Configuration utilities for the BlueSky plugin.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  BlueSkyConfigSchema,
  BlueSkyConfig,
  BLUESKY_SERVICE_URL,
  BLUESKY_POLL_INTERVAL,
  BLUESKY_POST_INTERVAL_MIN,
  BLUESKY_POST_INTERVAL_MAX,
  BLUESKY_ACTION_INTERVAL,
  BLUESKY_MAX_ACTIONS,
} from "../types";

export type { BlueSkyConfig };

export function getApiKeyOptional(runtime: IAgentRuntime, key: string): string | undefined {
  return runtime.getSetting(key) ?? undefined;
}

export function hasBlueSkyEnabled(runtime: IAgentRuntime): boolean {
  const enabled = runtime.getSetting("BLUESKY_ENABLED");
  if (enabled) return enabled.toLowerCase() === "true";
  return Boolean(runtime.getSetting("BLUESKY_HANDLE") && runtime.getSetting("BLUESKY_PASSWORD"));
}

export function validateBlueSkyConfig(runtime: IAgentRuntime): BlueSkyConfig {
  const result = BlueSkyConfigSchema.safeParse({
    handle: runtime.getSetting("BLUESKY_HANDLE") ?? "",
    password: runtime.getSetting("BLUESKY_PASSWORD") ?? "",
    service: runtime.getSetting("BLUESKY_SERVICE") ?? BLUESKY_SERVICE_URL,
    dryRun: runtime.getSetting("BLUESKY_DRY_RUN") === "true",
    pollInterval: parseInt(runtime.getSetting("BLUESKY_POLL_INTERVAL") ?? "", 10) || BLUESKY_POLL_INTERVAL,
    enablePost: runtime.getSetting("BLUESKY_ENABLE_POSTING") !== "false",
    postIntervalMin: parseInt(runtime.getSetting("BLUESKY_POST_INTERVAL_MIN") ?? "", 10) || BLUESKY_POST_INTERVAL_MIN,
    postIntervalMax: parseInt(runtime.getSetting("BLUESKY_POST_INTERVAL_MAX") ?? "", 10) || BLUESKY_POST_INTERVAL_MAX,
    enableActionProcessing: runtime.getSetting("BLUESKY_ENABLE_ACTION_PROCESSING") !== "false",
    actionInterval: parseInt(runtime.getSetting("BLUESKY_ACTION_INTERVAL") ?? "", 10) || BLUESKY_ACTION_INTERVAL,
    postImmediately: runtime.getSetting("BLUESKY_POST_IMMEDIATELY") === "true",
    maxActionsProcessing: parseInt(runtime.getSetting("BLUESKY_MAX_ACTIONS_PROCESSING") ?? "", 10) || BLUESKY_MAX_ACTIONS,
    enableDMs: runtime.getSetting("BLUESKY_ENABLE_DMS") !== "false",
  });

  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
    throw new Error(`Invalid BlueSky configuration: ${errors}`);
  }

  return result.data;
}

export function getPollInterval(runtime: IAgentRuntime): number {
  const seconds = parseInt(runtime.getSetting("BLUESKY_POLL_INTERVAL") ?? "", 10) || BLUESKY_POLL_INTERVAL;
  return seconds * 1000;
}

export function getActionInterval(runtime: IAgentRuntime): number {
  const seconds = parseInt(runtime.getSetting("BLUESKY_ACTION_INTERVAL") ?? "", 10) || BLUESKY_ACTION_INTERVAL;
  return seconds * 1000;
}

export function getMaxActionsProcessing(runtime: IAgentRuntime): number {
  return parseInt(runtime.getSetting("BLUESKY_MAX_ACTIONS_PROCESSING") ?? "", 10) || BLUESKY_MAX_ACTIONS;
}

export function isPostingEnabled(runtime: IAgentRuntime): boolean {
  return runtime.getSetting("BLUESKY_ENABLE_POSTING") !== "false";
}

export function shouldPostImmediately(runtime: IAgentRuntime): boolean {
  return runtime.getSetting("BLUESKY_POST_IMMEDIATELY") === "true";
}

export function getPostIntervalRange(runtime: IAgentRuntime): { min: number; max: number } {
  const min = parseInt(runtime.getSetting("BLUESKY_POST_INTERVAL_MIN") ?? "", 10) || BLUESKY_POST_INTERVAL_MIN;
  const max = parseInt(runtime.getSetting("BLUESKY_POST_INTERVAL_MAX") ?? "", 10) || BLUESKY_POST_INTERVAL_MAX;
  return { min: min * 1000, max: max * 1000 };
}
