import { AgentRuntime, Character, stringToUuid, RuntimeSettings } from '@elizaos/core';
import { loadEnvironmentVariables } from './env-loader';

// --- Start of Pre-emptive Environment Loading ---
// This block MUST execute before any plugin imports to ensure
// environment variables are available system-wide.

console.log('[ENV] Loading environment configuration...');
loadEnvironmentVariables();

// Get the loaded environment settings
const envSettings = process.env as RuntimeSettings;
console.log(`[ENV] Environment loaded with ${Object.keys(envSettings).length} variables`);
// --- End of Pre-emptive Environment Loading ---

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

  // Use the loaded environment settings
  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, e2bPlugin, openaiPlugin],
    settings: envSettings
  });

  // Initialize the runtime to set up services
  await runtime.initialize();

  return runtime;
}