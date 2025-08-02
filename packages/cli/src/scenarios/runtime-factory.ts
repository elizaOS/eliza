import { AgentRuntime, Character, stringToUuid } from '@elizaos/core';
import { loadEnvConfig } from '../commands/start/utils/config-utils';
import { plugin as sqlPlugin } from '@elizaos/plugin-sql';
import { e2bPlugin } from '@elizaos/plugin-e2b';
import { openaiPlugin } from '@elizaos/plugin-openai';

/**
 * Creates a minimal runtime with E2B, SQL, and OpenAI plugins loaded for scenario execution
 */
export async function createE2BRuntime(): Promise<AgentRuntime> {
  // Create minimal character for E2B operations
  const character: Character = {
    name: 'scenario-runner',
    id: stringToUuid('scenario-runner'),
    bio: 'A minimal character for running E2B scenarios',
    plugins: [
      '@elizaos/plugin-sql',
      '@elizaos/plugin-e2b',
      '@elizaos/plugin-openai'
    ]
  };

  // Create minimal runtime with SQL, E2B, and OpenAI plugins
  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, e2bPlugin, openaiPlugin],
    settings: await loadEnvConfig() // Load E2B_API_KEY, E2B_MODE, etc.
  });

  // Initialize the runtime to set up services
  await runtime.initialize();

  return runtime;
}