/**
 * Helper to get the PluginCreationService from runtime.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { PluginCreationService } from "../services/plugin-creation-service";

/**
 * Get the PluginCreationService from runtime.
 *
 * We need this because we can't extend ServiceTypeRegistry due to core constraints.
 */
export function getPluginCreationService(
  runtime: IAgentRuntime
): PluginCreationService | undefined {
  // Cast to bypass type check since we can't extend ServiceTypeRegistry
  const services = runtime.services as Map<string, unknown>;
  return services.get("plugin_creation") as PluginCreationService | undefined;
}
