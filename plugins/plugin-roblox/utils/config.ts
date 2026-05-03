import type { IAgentRuntime } from "@elizaos/core";
import type { RobloxConfig } from "../types";

export const ROBLOX_DEFAULTS = {
  MESSAGING_TOPIC: "eliza-agent",
  POLL_INTERVAL: 30,
  DRY_RUN: false,
} as const;

export function hasRobloxEnabled(runtime: IAgentRuntime): boolean {
  const apiKey = runtime.getSetting("ROBLOX_API_KEY");
  const universeId = runtime.getSetting("ROBLOX_UNIVERSE_ID");
  return Boolean(apiKey && universeId);
}

export function getRobloxApiKey(runtime: IAgentRuntime): string | undefined {
  return runtime.getSetting("ROBLOX_API_KEY") as string | undefined;
}

export function getRobloxUniverseId(runtime: IAgentRuntime): string | undefined {
  return runtime.getSetting("ROBLOX_UNIVERSE_ID") as string | undefined;
}

export function validateRobloxConfig(runtime: IAgentRuntime): RobloxConfig {
  const apiKey = runtime.getSetting("ROBLOX_API_KEY") as string | undefined;
  const universeId = runtime.getSetting("ROBLOX_UNIVERSE_ID") as string | undefined;

  if (!apiKey) {
    throw new Error("ROBLOX_API_KEY is required but not configured");
  }

  if (!universeId) {
    throw new Error("ROBLOX_UNIVERSE_ID is required but not configured");
  }

  const placeId = runtime.getSetting("ROBLOX_PLACE_ID") as string | undefined;
  const webhookSecret = runtime.getSetting("ROBLOX_WEBHOOK_SECRET") as string | undefined;
  const messagingTopic =
    (runtime.getSetting("ROBLOX_MESSAGING_TOPIC") as string) || ROBLOX_DEFAULTS.MESSAGING_TOPIC;
  const pollIntervalStr = runtime.getSetting("ROBLOX_POLL_INTERVAL") as string | undefined;
  const pollInterval = pollIntervalStr
    ? parseInt(pollIntervalStr, 10)
    : ROBLOX_DEFAULTS.POLL_INTERVAL;
  const dryRunStr = runtime.getSetting("ROBLOX_DRY_RUN") as string | undefined;
  const dryRun = dryRunStr === "true";

  return {
    apiKey,
    universeId,
    placeId,
    webhookSecret,
    messagingTopic,
    pollInterval,
    dryRun,
  };
}
