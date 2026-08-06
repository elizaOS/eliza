/**
 * Owns the personal-assistant runtime state that makes activity-signal
 * ingestion available. The activation marker is separate from the source
 * registry so route availability follows plugin lifecycle, not retained
 * registry data.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  createSignalSourceRegistry,
  registerSignalSourceRegistry,
  unregisterSignalSourceRegistry,
} from "./registries/signal-source-registry.js";
import { registerBuiltinSignalSources } from "./telemetry-mapping.js";

const activeRuntimes = new WeakSet<IAgentRuntime>();

export function activateLifeOpsActivitySignals(runtime: IAgentRuntime): void {
  const registry = createSignalSourceRegistry();
  registerBuiltinSignalSources(registry);
  registerSignalSourceRegistry(runtime, registry);
  activeRuntimes.add(runtime);
}

export function deactivateLifeOpsActivitySignals(runtime: IAgentRuntime): void {
  activeRuntimes.delete(runtime);
  unregisterSignalSourceRegistry(runtime);
}

export function areLifeOpsActivitySignalsActive(
  runtime: IAgentRuntime,
): boolean {
  return activeRuntimes.has(runtime);
}
