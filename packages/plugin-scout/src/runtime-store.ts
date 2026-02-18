import type { IAgentRuntime } from "@elizaos/core";
import type { ScoutClient } from "./client/scout-client.js";
import type { ScoutPluginConfig } from "./config.js";

/**
 * WeakMap-based runtime store for plugin state.
 * Avoids monkey-patching IAgentRuntime with `as any` casts.
 * WeakMap keys are garbage-collected when the runtime is disposed.
 */

const clients = new WeakMap<IAgentRuntime, ScoutClient>();
const configs = new WeakMap<IAgentRuntime, ScoutPluginConfig>();

export function setScoutClient(runtime: IAgentRuntime, client: ScoutClient): void {
  clients.set(runtime, client);
}

export function getScoutClient(runtime: IAgentRuntime): ScoutClient | undefined {
  return clients.get(runtime);
}

export function setScoutConfig(runtime: IAgentRuntime, config: ScoutPluginConfig): void {
  configs.set(runtime, config);
}

export function getScoutConfig(runtime: IAgentRuntime): ScoutPluginConfig | undefined {
  return configs.get(runtime);
}