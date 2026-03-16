import type { IAgentRuntime } from "@elizaos/core";
import type { PluginCreationService } from "../services/plugin-creation-service";

export function getPluginCreationService(
  runtime: IAgentRuntime
): PluginCreationService | undefined {
  const services = runtime.services as Map<string, unknown>;
  return services.get("plugin_creation") as PluginCreationService | undefined;
}
