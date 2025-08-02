import { AgentRuntime, Character, stringToUuid } from '@elizaos/core';
import { loadEnvConfig } from '../commands/start/utils/config-utils';

/**
 * Creates a minimal runtime with only the E2B plugin loaded for scenario execution
 */
export async function createE2BRuntime(): Promise<AgentRuntime> {
  let e2bPlugin;
  
  try {
    // Try to import the E2B plugin from the installed dependency
    const e2bModule = await import('@elizaos/plugin-e2b');
    e2bPlugin = e2bModule.plugin;
  } catch (error) {
    throw new Error(
      'E2B plugin not available. Please ensure @elizaos/plugin-e2b is properly installed and built. ' +
      'Error: ' + (error as Error).message
    );
  }

  // Create minimal character for E2B operations
  const character: Character = {
    name: 'scenario-runner',
    id: stringToUuid('scenario-runner'),
    bio: 'A minimal character for running E2B scenarios',
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