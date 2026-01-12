import type { IAgentRuntime } from "@elizaos/core";
import {
  BLUESKY_ACTION_INTERVAL,
  BLUESKY_MAX_ACTIONS,
  BLUESKY_POLL_INTERVAL,
  BLUESKY_POST_INTERVAL_MAX,
  BLUESKY_POST_INTERVAL_MIN,
  BLUESKY_SERVICE_URL,
  type BlueSkyConfig,
  BlueSkyConfigSchema,
} from "../types";

export type { BlueSkyConfig };

export function getApiKeyOptional(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" ? value : undefined;
}

export function hasBlueSkyEnabled(runtime: IAgentRuntime): boolean {
  const enabled = runtime.getSetting("BLUESKY_ENABLED");
  if (enabled) return String(enabled).toLowerCase() === "true";
  return Boolean(runtime.getSetting("BLUESKY_HANDLE") && runtime.getSetting("BLUESKY_PASSWORD"));
}

export function validateBlueSkyConfig(runtime: IAgentRuntime): BlueSkyConfig {
  const result = BlueSkyConfigSchema.safeParse({
    handle: String(runtime.getSetting("BLUESKY_HANDLE") ?? ""),
    password: String(runtime.getSetting("BLUESKY_PASSWORD") ?? ""),
    service: String(runtime.getSetting("BLUESKY_SERVICE") ?? BLUESKY_SERVICE_URL),
    dryRun: runtime.getSetting("BLUESKY_DRY_RUN") === "true",
    pollInterval:
      parseInt(String(runtime.getSetting("BLUESKY_POLL_INTERVAL") ?? ""), 10) ||
      BLUESKY_POLL_INTERVAL,
    enablePost: runtime.getSetting("BLUESKY_ENABLE_POSTING") !== "false",
    postIntervalMin:
      parseInt(String(runtime.getSetting("BLUESKY_POST_INTERVAL_MIN") ?? ""), 10) ||
      BLUESKY_POST_INTERVAL_MIN,
    postIntervalMax:
      parseInt(String(runtime.getSetting("BLUESKY_POST_INTERVAL_MAX") ?? ""), 10) ||
      BLUESKY_POST_INTERVAL_MAX,
    enableActionProcessing: runtime.getSetting("BLUESKY_ENABLE_ACTION_PROCESSING") !== "false",
    actionInterval:
      parseInt(String(runtime.getSetting("BLUESKY_ACTION_INTERVAL") ?? ""), 10) ||
      BLUESKY_ACTION_INTERVAL,
    postImmediately: runtime.getSetting("BLUESKY_POST_IMMEDIATELY") === "true",
    maxActionsProcessing:
      parseInt(String(runtime.getSetting("BLUESKY_MAX_ACTIONS_PROCESSING") ?? ""), 10) ||
      BLUESKY_MAX_ACTIONS,
    enableDMs: runtime.getSetting("BLUESKY_ENABLE_DMS") !== "false",
  });

  if (!result.success) {
    const errors =
      (result.error as { errors?: { path: string[]; message: string }[] }).errors
        ?.map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ") || result.error.toString();
    throw new Error(`Invalid BlueSky configuration: ${errors}`);
  }

  return result.data;
}

export function getPollInterval(runtime: IAgentRuntime): number {
  const seconds =
    parseInt(String(runtime.getSetting("BLUESKY_POLL_INTERVAL") ?? ""), 10) ||
    BLUESKY_POLL_INTERVAL;
  return seconds * 1000;
}

export function getActionInterval(runtime: IAgentRuntime): number {
  const seconds =
    parseInt(String(runtime.getSetting("BLUESKY_ACTION_INTERVAL") ?? ""), 10) ||
    BLUESKY_ACTION_INTERVAL;
  return seconds * 1000;
}

export function getMaxActionsProcessing(runtime: IAgentRuntime): number {
  return (
    parseInt(String(runtime.getSetting("BLUESKY_MAX_ACTIONS_PROCESSING") ?? ""), 10) ||
    BLUESKY_MAX_ACTIONS
  );
}

export function isPostingEnabled(runtime: IAgentRuntime): boolean {
  return runtime.getSetting("BLUESKY_ENABLE_POSTING") !== "false";
}

export function shouldPostImmediately(runtime: IAgentRuntime): boolean {
  return runtime.getSetting("BLUESKY_POST_IMMEDIATELY") === "true";
}

export function getPostIntervalRange(runtime: IAgentRuntime): {
  min: number;
  max: number;
} {
  const min =
    parseInt(String(runtime.getSetting("BLUESKY_POST_INTERVAL_MIN") ?? ""), 10) ||
    BLUESKY_POST_INTERVAL_MIN;
  const max =
    parseInt(String(runtime.getSetting("BLUESKY_POST_INTERVAL_MAX") ?? ""), 10) ||
    BLUESKY_POST_INTERVAL_MAX;
  return { min: min * 1000, max: max * 1000 };
}
