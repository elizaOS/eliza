/**
 * Helper to get the PluginCreationService from runtime.
 */

import { IAgentRuntime } from "@elizaos/core";
import { PluginCreationService } from "../services/plugin-creation-service";

/**
 * Get the PluginCreationService from runtime.
 *
 * We need this because we can't extend ServiceTypeRegistry due to core constraints.
 */
export function getPluginCreationService(
  runtime: IAgentRuntime
): PluginCreationService | undefined {
  // Cast to bypass type check since we can't extend ServiceTypeRegistry
  return runtime.services.get(
    "plugin_creation" as keyof typeof runtime.services
  ) as PluginCreationService | undefined;
}


