import { AgentRuntime, Character, stringToUuid } from '@elizaos/core';
import { loadEnvConfig } from '../commands/start/utils/config-utils';
import { loadAndPreparePlugin } from '../commands/start/utils/plugin-utils';

/**
 * Creates a minimal runtime with only the E2B plugin loaded for scenario execution
 */
export async function createE2BRuntime(): Promise<AgentRuntime> {
  // Load the E2B plugin
  const e2bPlugin = await loadAndPreparePlugin('@elizaos/plugin-e2b');
  if (!e2bPlugin) {
    throw new Error('Failed to load @elizaos/plugin-e2b plugin. Please ensure it is installed.');
  }

  // Create minimal character for E2B operations
  const character: Character = {
    name: 'scenario-runner',
    id: stringToUuid('scenario-runner'),
    plugins: ['@elizaos/plugin-e2b']
  };

  // Create minimal runtime with only E2B plugin
  const runtime = new AgentRuntime({
    character,
    plugins: [e2bPlugin],
    settings: await loadEnvConfig() // Load E2B_API_KEY, E2B_MODE, etc.
  });

  // Initialize the runtime to set up services
  await runtime.initialize();

  return runtime;
} 