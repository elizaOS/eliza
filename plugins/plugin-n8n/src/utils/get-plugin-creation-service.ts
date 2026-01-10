import { IAgentRuntime } from '@elizaos/core';
import { PluginCreationService } from '../services/plugin-creation-service.ts';

/**
 * Helper function to get the PluginCreationService from runtime
 * We need this because we can't extend ServiceTypeRegistry due to core constraints
 */
export function getPluginCreationService(
  runtime: IAgentRuntime
): PluginCreationService | undefined {
  // Cast to any to bypass type check since we can't extend ServiceTypeRegistry
  return runtime.services.get('plugin_creation' as any) as PluginCreationService | undefined;
}
