import type { Plugin, Character, IAgentRuntime } from '@elizaos/core';
import { AgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';

/**
 * Creates a test agent runtime with specified plugins for testing scenarios
 */
export async function createTestAgent(
  plugins: Plugin[],
  serverPort: number
): Promise<IAgentRuntime> {
  logger.debug(`Creating test agent runtime with ${plugins.length} plugins...`);
  logger.debug(`Available plugins: ${plugins.map(p => p.name).join(', ')}`);

  // Ensure we have the SQL plugin for database operations
  let effectivePlugins = [...plugins];
  const hasSqlPlugin = plugins.some(p => p.name === '@elizaos/plugin-sql');
  
  if (!hasSqlPlugin) {
    try {
      // Try to dynamically import the SQL plugin
      const sqlPluginModule = await import('@elizaos/plugin-sql');
      const sqlPlugin = sqlPluginModule.default || sqlPluginModule.plugin;
      if (sqlPlugin && typeof sqlPlugin === 'object' && 'name' in sqlPlugin && 'description' in sqlPlugin) {
        effectivePlugins.push(sqlPlugin as Plugin);
        logger.debug('Added SQL plugin for test runtime');
      }
    } catch (error) {
      logger.warn('Could not load SQL plugin for test runtime:', error);
    }
  }

  // Create a basic test character
  const testCharacter: Character = {
    name: 'ScenarioTestAgent',
    bio: ['A test agent for running scenarios'],
    system: 'You are a test agent running scenario tests. Respond naturally to all interactions.',
    plugins: effectivePlugins.map(p => p.name),
    messageExamples: [
      [
        { name: 'user', content: { text: 'Hello' } },
        { name: 'ScenarioTestAgent', content: { text: 'Hello! I am ready to run scenario tests.' } }
      ]
    ],
    postExamples: [],
    topics: ['testing', 'scenarios'],
    adjectives: ['helpful', 'reliable', 'thorough'],
    knowledge: [],
    settings: {
      TEST_MODE: true,
      SERVER_PORT: serverPort
    }
  };

  try {
    // Create the runtime
    const runtime = new AgentRuntime({
      character: testCharacter,
      // Use the effective plugins (including SQL if needed)
      plugins: effectivePlugins
    });

    // Initialize the runtime
    await runtime.initialize();

    logger.debug(`Test agent runtime created with ${effectivePlugins.length} plugins`);
    return runtime;

  } catch (error) {
    logger.error(`Failed to create test agent runtime: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Creates test character instances for scenario execution
 */
export async function createScenarioCharacters(
  scenarioCharacters: Array<{
    id: string;
    name: string;
    role: 'subject' | 'observer' | 'assistant' | 'adversary';
    bio?: string;
    system?: string;
    plugins: string[];
    settings?: Record<string, any>;
  }>,
  availablePlugins: Plugin[]
): Promise<Map<string, IAgentRuntime>> {
  const characterRuntimes = new Map<string, IAgentRuntime>();

  for (const scenarioChar of scenarioCharacters) {
    logger.debug(`Creating character runtime for: ${scenarioChar.name}`);

    // Filter plugins to only those required by this character
    const characterPlugins = availablePlugins.filter(p => 
      scenarioChar.plugins.includes(p.name)
    );

    const character: Character = {
      name: scenarioChar.name,
      bio: scenarioChar.bio ? [scenarioChar.bio] : [`A ${scenarioChar.role} character for scenario testing`],
      system: scenarioChar.system || `You are a ${scenarioChar.role} in a scenario test. Act according to your role naturally.`,
      plugins: scenarioChar.plugins,
      messageExamples: [
        [
          { name: 'user', content: { text: 'Hello' } },
          { name: scenarioChar.name, content: { text: `Hello! I'm ${scenarioChar.name}, acting as a ${scenarioChar.role}.` } }
        ]
      ],
      postExamples: [],
      topics: ['scenario-testing'],
      adjectives: [scenarioChar.role],
      knowledge: [],
      settings: {
        ...scenarioChar.settings,
        SCENARIO_ROLE: scenarioChar.role,
        CHARACTER_ID: scenarioChar.id
      }
    };

    try {
      const runtime = new AgentRuntime({
        character: character,
        plugins: characterPlugins
      });

      await runtime.initialize();
      characterRuntimes.set(scenarioChar.id, runtime);

      logger.debug(`Character runtime created for ${scenarioChar.name} with ${characterPlugins.length} plugins`);

    } catch (error) {
      logger.error(`Failed to create character runtime for ${scenarioChar.name}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  return characterRuntimes;
}

/**
 * Cleanup test agent runtimes
 */
export async function cleanupTestAgents(runtimes: IAgentRuntime[]): Promise<void> {
  logger.debug('Cleaning up test agent runtimes...');

  for (const runtime of runtimes) {
    try {
      // Stop all services
      for (const [serviceName, service] of runtime.services) {
        try {
          await service.stop();
          logger.debug(`Stopped service: ${serviceName}`);
        } catch (error) {
          logger.warn(`Failed to stop service ${serviceName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      logger.debug(`Cleaned up runtime for agent: ${runtime.character.name}`);
    } catch (error) {
      logger.warn(`Error cleaning up runtime: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}