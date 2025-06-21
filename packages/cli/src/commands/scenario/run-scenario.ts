import { logger, type IAgentRuntime, type Plugin } from '@elizaos/core';
// Make ALL imports dynamic to avoid loading schema modules before setting database type
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import * as path from 'path';

export async function runScenarioWithAgents(
  scenario: any, // Use any to avoid static import of types
  options: any
): Promise<any> {
  // CRITICAL: Set database type FIRST before ANY other operations
  // This must happen before any schema modules are imported or database operations occur
  const sqlModule = await import('@elizaos/plugin-sql');
  // Access setDatabaseType as a named export and call it properly
  if ('setDatabaseType' in sqlModule && typeof sqlModule.setDatabaseType === 'function') {
    sqlModule.setDatabaseType('pglite');
    logger.info('✅ Successfully set database type to PGLite for scenario testing');
  } else {
    logger.error('❌ setDatabaseType not found or not a function in plugin-sql module');
    logger.error('Available exports:', Object.keys(sqlModule));
  }

  logger.info(`🚀 Starting scenario: ${scenario.name}`);

  // Now safe to import AgentServer after database type is set
  const { AgentServer } = await import('@elizaos/server');
  logger.info('✅ Imported AgentServer after setting database type');

  // Load environment variables from .env file
  try {
    // Import UserEnvironment dynamically
    const { UserEnvironment } = await import('../../utils/user-environment.js');
    const userEnv = UserEnvironment.getInstance();
    const pathsInfo = await userEnv.getPathInfo();

    if (pathsInfo.envFilePath && existsSync(pathsInfo.envFilePath)) {
      dotenv.config({ path: pathsInfo.envFilePath });
      logger.info(`Loaded environment variables from: ${pathsInfo.envFilePath}`);
    } else {
      logger.warn(`No .env file found at: ${pathsInfo.envFilePath}`);
    }
  } catch (error) {
    logger.warn('Failed to load environment variables:', error);
  }

  // Initialize server
  const server = new AgentServer();
  await server.initialize({
    dataDir: path.join(process.cwd(), '.scenario-test-db'),
  });

  logger.info('Server initialized successfully');

  const agents: Map<string, IAgentRuntime> = new Map();

  try {
    // Instead of loading a project, we'll create agents based on the scenario
    const plugins: Plugin[] = [];

    // Always include SQL plugin for database support
    try {
      const sqlModule = await import('@elizaos/plugin-sql');
      plugins.push(sqlModule.plugin);
    } catch (error) {
      logger.warn('Failed to load SQL plugin:', error);
    }

    // Always include bootstrap plugin for message handling
    try {
      // @ts-ignore: plugin-bootstrap may not be available in all configurations
      const bootstrapModule = await import('@elizaos/plugin-bootstrap');
      const bootstrapPlugin =
        bootstrapModule.default || (bootstrapModule as any).plugin || bootstrapModule;
      if (bootstrapPlugin && bootstrapPlugin.name) {
        plugins.push(bootstrapPlugin as Plugin);
        logger.info('Loaded bootstrap plugin for message handling');
      }
    } catch (error) {
      logger.warn('Failed to load bootstrap plugin (may not be available):', error);
    }

    // Always include OpenAI plugin for embeddings and LLM
    try {
      // @ts-ignore: plugin-openai may not be available in all configurations
      const openaiModule = await import('@elizaos/plugin-openai');
      const openaiPlugin = openaiModule.default || (openaiModule as any).plugin || openaiModule;
      if (openaiPlugin && openaiPlugin.name) {
        plugins.push(openaiPlugin as Plugin);
        logger.info('Loaded OpenAI plugin for LLM capabilities');
      }
    } catch (error) {
      logger.warn('Failed to load OpenAI plugin (may not be available):', error);
    }

    // Map short plugin names to full package names
    const pluginPackageMap: Record<string, string> = {
      // Core plugins
      rolodex: '@elizaos/plugin-rolodex',
      '@elizaos/plugin-rolodex': '@elizaos/plugin-rolodex',
      'message-handling': '@elizaos/plugin-message-handling',
      openai: '@elizaos/plugin-openai',
      anthropic: '@elizaos/plugin-anthropic',
      sql: '@elizaos/plugin-sql',
      bootstrap: '@elizaos/plugin-bootstrap',

      // Knowledge and research plugins
      knowledge: '@elizaos/plugin-knowledge',
      research: '@elizaos/plugin-research',
      'web-search': '@elizaos/plugin-web-search',

      // Planning and task management
      planning: '@elizaos/plugin-planning',
      todo: '@elizaos/plugin-todo',
      goals: '@elizaos/plugin-goals',

      // Automation and web plugins
      stagehand: '@elizaos/plugin-stagehand',
      'plugin-manager': '@elizaos/plugin-plugin-manager',

      // GitHub integration
      github: '@elizaos/plugin-github',

      // Blockchain plugins
      solana: '@elizaos/plugin-solana',
      evm: '@elizaos/plugin-evm',

      // Additional utility plugins
      'secrets-manager': '@elizaos/plugin-secrets-manager',
      shell: '@elizaos/plugin-shell',
      trust: '@elizaos/plugin-trust',
      mcp: '@elizaos/plugin-mcp',
      ngrok: '@elizaos/plugin-ngrok',

      // AI model plugins
      agentkit: '@elizaos/plugin-agentkit',
      autocoder: '@elizaos/plugin-autocoder',

      // Alternative naming patterns
      '@elizaos/plugin-research': '@elizaos/plugin-research',
      '@elizaos/plugin-knowledge': '@elizaos/plugin-knowledge',
      '@elizaos/plugin-planning': '@elizaos/plugin-planning',
      '@elizaos/plugin-todo': '@elizaos/plugin-todo',
      '@elizaos/plugin-stagehand': '@elizaos/plugin-stagehand',
      '@elizaos/plugin-solana': '@elizaos/plugin-solana',
      '@elizaos/plugin-evm': '@elizaos/plugin-evm',
      '@elizaos/plugin-github': '@elizaos/plugin-github',
    };

    // Load environment-level plugins
    const environmentPlugins = [...plugins];

    if (scenario.setup?.environment?.plugins) {
      for (const pluginName of scenario.setup.environment.plugins) {
        try {
          const fullPluginName = pluginPackageMap[pluginName] || pluginName;
          const pluginModule = await import(fullPluginName);
          const plugin = pluginModule.default || pluginModule.plugin || pluginModule;
          if (plugin) {
            environmentPlugins.push(plugin);
            logger.info(`Loaded environment plugin: ${fullPluginName}`);
          }
        } catch (error) {
          logger.warn(`Failed to load environment plugin ${pluginName}:`, error);
        }
      }
    }

    // Create agents for the scenario
    for (const actor of scenario.actors) {
      // Load actor-specific plugins
      const actorPlugins = [...plugins];

      // Check for plugins in the actor definition
      const pluginList = actor.plugins || [];

      if (pluginList.length > 0) {
        for (const pluginName of pluginList) {
          try {
            const pluginModule = await import(pluginName);
            // Handle different export formats
            const plugin = pluginModule.default || (pluginModule as any).plugin || pluginModule;

            if (plugin && plugin.name) {
              // Ensure it's a valid plugin
              actorPlugins.push(plugin);
              logger.info(`Loaded plugin: ${pluginName} for actor: ${actor.name}`);
            }
          } catch (error) {
            logger.warn(`Failed to load plugin ${pluginName}:`, error);
          }
        }
      }

      // Construct character from actor properties
      const character = {
        name: actor.name,
        bio: actor.bio
          ? [actor.bio]
          : [`I am ${actor.name}, a helpful AI assistant participating in a scenario test.`],
        system:
          actor.system ||
          `You are ${actor.name}, a helpful AI assistant participating in a scenario test.`,
        modelProvider: 'openai',
        settings: {
          model: 'gpt-4o-mini',
          temperature: 0.7,
        },
        plugins: pluginList, // Include the plugins in the character
      };

      // Ensure character has necessary settings
      character.settings = {
        ...character.settings,
        model: character.settings?.model || 'gpt-4o-mini',
        temperature: character.settings?.temperature || 0.7,
      };

      // Add environment variables to character settings for API keys
      if (process.env.OPENAI_API_KEY) {
        (character.settings as any).OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      }
      if (process.env.ANTHROPIC_API_KEY) {
        (character.settings as any).ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      }

      // Set plugins on the character
      character.plugins = actorPlugins.map((p) => p.name);

      // Create runtime directly
      const { AgentRuntime } = await import('@elizaos/core');

      const runtime = new AgentRuntime({
        character,
        plugins: actorPlugins,
        // @ts-ignore - using internal API
        databaseAdapter: server.adapter || server,
        serverUrl: 'http://localhost:3000',
        token: `scenario-${actor.id}`,
        getSetting: (key: string) => {
          // Check character settings first
          const characterValue = (character.settings as any)?.[key];
          if (characterValue !== undefined) {
            return characterValue;
          }

          // Then check environment variables
          const envValue = process.env[key];
          if (envValue !== undefined) {
            return envValue;
          }

          // Default values for common settings
          const defaults: Record<string, any> = {
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
            GROQ_API_KEY: process.env.GROQ_API_KEY,
            TOGETHER_API_KEY: process.env.TOGETHER_API_KEY,
          };

          return defaults[key];
        },
      });

      await runtime.initialize();

      agents.set(actor.name, runtime);
      logger.info(`Created agent: ${actor.name} with ID: ${runtime.agentId}`);
    }

    // Get the primary runtime (subject agent)
    const subjectActor = scenario.actors.find((a: any) => a.role === 'subject');
    const primaryRuntime = subjectActor
      ? agents.get(subjectActor.name)
      : agents.values().next().value;

    if (!primaryRuntime) {
      throw new Error('No primary runtime available');
    }

    // Create scenario runner with dynamic import
    const { ScenarioRunner } = await import('../../scenario-runner/index.js');
    const runner = new ScenarioRunner(server, primaryRuntime);

    // Pass the agents to the runner
    // @ts-ignore - adding agents property
    runner.agents = agents;

    // Run the scenario
    const result = await runner.runScenario(scenario, {
      verbose: options.verbose,
      benchmark: options.benchmark,
    });

    return result;
  } catch (error) {
    logger.error('Failed to run scenario:', error);
    logger.error('Error details:', error instanceof Error ? error.stack : String(error));

    // Return a failed result
    return {
      scenarioId: scenario.id,
      name: scenario.name,
      passed: false,
      duration: 0,
      score: 0,
      startTime: Date.now(),
      endTime: Date.now(),
      metrics: {
        duration: 0,
        messageCount: 0,
        stepCount: 0,
        tokenUsage: { input: 0, output: 0, total: 0 },
        memoryUsage: { peak: 0, average: 0, memoryOperations: 0 },
        actionCounts: {},
        responseLatency: { min: 0, max: 0, average: 0, p95: 0 },
      },
      verificationResults: [],
      transcript: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  } finally {
    // Cleanup
    try {
      // Unregister agents
      for (const runtime of agents.values()) {
        await server.unregisterAgent(runtime.agentId);
      }

      // Stop server
      await server.stop();
    } catch (cleanupError) {
      logger.warn('Cleanup error:', cleanupError);
    }
  }
}
