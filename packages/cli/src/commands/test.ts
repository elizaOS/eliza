import { buildProject } from '@/src/utils/build-project';
import { type IAgentRuntime, type ProjectAgent, logger } from '@elizaos/core';
import { Command } from 'commander';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import path from 'node:path';
import { loadProject } from '../project.js';
import { AgentServer } from '../server/index.js';
import { jsonToCharacter, loadCharacterTryPath } from '../server/loader';
import { TestRunner } from '../testRunner.js';
import { promptForEnvVars } from '../utils/env-prompt.js';
import { startAgent } from './start.js';

// Helper function to check port availability
async function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}

/**
 * Check if the current directory is likely a plugin directory
 */
function checkIfLikelyPluginDir(dir: string): boolean {
  // Simple check based on common file patterns
  return (
    dir.includes('plugin') ||
    existsSync(path.join(dir, 'src/plugin.ts')) ||
    (existsSync(path.join(dir, 'src/index.ts')) && !existsSync(path.join(dir, 'src/agent.ts')))
  );
}

/**
 * Function that runs the tests.
 */
const runAgentTests = async (options: {
  port?: number;
  plugin?: string;
  skipPlugins?: boolean;
  skipProjectTests?: boolean;
  skipBuild?: boolean;
}) => {
  // Build the project or plugin first unless skip-build is specified
  if (options && !options.skipBuild) {
    try {
      const cwd = process.cwd();
      const isPlugin = options.plugin ? true : checkIfLikelyPluginDir(cwd);
      logger.info(`Building ${isPlugin ? 'plugin' : 'project'}...`);
      await buildProject(cwd, isPlugin);
      logger.info(`Build completed successfully`);
    } catch (buildError) {
      logger.error(`Build error: ${buildError}`);
      logger.warn(`Attempting to continue with tests despite build error`);
      // Continue with tests despite build error - the project might already be built
    }
  }

  try {
    const runtimes: IAgentRuntime[] = [];
    const projectAgents: ProjectAgent[] = [];

    // Set up standard paths and load .env
    const homeDir = os.homedir();
    const elizaDir = path.join(homeDir, '.eliza');
    const elizaDbDir = path.join(elizaDir, 'db');
    const envFilePath = path.join(elizaDir, '.env');

    logger.info('Setting up environment...');
    logger.info(`Home directory: ${homeDir}`);
    logger.info(`Eliza directory: ${elizaDir}`);
    logger.info(`Database directory: ${elizaDbDir}`);
    logger.info(`Environment file: ${envFilePath}`);

    // Create .eliza directory if it doesn't exist
    if (!fs.existsSync(elizaDir)) {
      logger.info(`Creating directory: ${elizaDir}`);
      fs.mkdirSync(elizaDir, { recursive: true });
      logger.info(`Created directory: ${elizaDir}`);
    }

    // Create db directory if it doesn't exist
    if (!fs.existsSync(elizaDbDir)) {
      logger.info(`Creating database directory: ${elizaDbDir}`);
      fs.mkdirSync(elizaDbDir, { recursive: true });
      logger.info(`Created database directory: ${elizaDbDir}`);
    }

    // Set the database directory in environment variables
    process.env.PGLITE_DATA_DIR = elizaDbDir;
    logger.info(`Using database directory: ${elizaDbDir}`);

    // Load environment variables from .eliza/.env if it exists
    if (fs.existsSync(envFilePath)) {
      logger.info(`Loading environment variables from: ${envFilePath}`);
      dotenv.config({ path: envFilePath });
      logger.info('Environment variables loaded');
    } else {
      logger.warn(`Environment file not found: ${envFilePath}`);
    }

    // Always ensure database configuration is set
    try {
      logger.info('Configuring database...');
      await promptForEnvVars('pglite');
      logger.info('Database configuration completed');
    } catch (error) {
      logger.error('Error configuring database:', error);
      if (error instanceof Error) {
        logger.error('Error details:', error.message);
        logger.error('Stack trace:', error.stack);
      }
      throw error;
    }

    // Look for PostgreSQL URL in environment variables
    const postgresUrl = process.env.POSTGRES_URL;
    logger.info(`PostgreSQL URL: ${postgresUrl ? 'found' : 'not found'}`);

    // Create server instance
    logger.info('Creating server instance...');
    const server = new AgentServer({
      dataDir: elizaDbDir,
      postgresUrl,
    });
    logger.info('Server instance created');

    // Wait for database initialization
    logger.info('Waiting for database initialization...');
    try {
      await new Promise<void>((resolve, reject) => {
        let initializationAttempts = 0;
        const maxAttempts = 5;
        const checkInterval = setInterval(async () => {
          try {
            // Check if the database is already initialized
            if (server.database?.isInitialized) {
              clearInterval(checkInterval);
              resolve();
              return;
            }

            // Try to initialize if not already initialized
            initializationAttempts++;
            try {
              await server.database?.init();
              // If we reach here without error, consider initialization successful
              clearInterval(checkInterval);
              resolve();
            } catch (initError) {
              logger.warn(
                `Database initialization attempt ${initializationAttempts}/${maxAttempts} failed:`,
                initError
              );

              // Check if we've reached the maximum attempts
              if (initializationAttempts >= maxAttempts) {
                if (server.database?.connection) {
                  // If we have a connection, consider it good enough even with migration errors
                  logger.warn(
                    'Max initialization attempts reached, but database connection exists. Proceeding anyway.'
                  );
                  clearInterval(checkInterval);
                  resolve();
                } else {
                  clearInterval(checkInterval);
                  reject(new Error(`Database initialization failed after ${maxAttempts} attempts`));
                }
              }
              // Otherwise, continue to next attempt
            }
          } catch (error) {
            logger.error('Error during database initialization check:', error);
            if (error instanceof Error) {
              logger.error('Error details:', error.message);
              logger.error('Stack trace:', error.stack);
            }
            clearInterval(checkInterval);
            reject(error);
          }
        }, 1000);

        // Timeout after 30 seconds
        setTimeout(() => {
          clearInterval(checkInterval);
          if (server.database?.connection) {
            // If we have a connection, consider it good enough even with initialization issues
            logger.warn(
              'Database initialization timeout, but connection exists. Proceeding anyway.'
            );
            resolve();
          } else {
            reject(new Error('Database initialization timed out after 30 seconds'));
          }
        }, 30000);
      });
      logger.info('Database initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize database:', error);
      if (error instanceof Error) {
        logger.error('Error details:', error.message);
        logger.error('Stack trace:', error.stack);
      }
      throw error;
    }

    // Set up server properties
    logger.info('Setting up server properties...');
    server.startAgent = async (character) => {
      logger.info(`Starting agent for character ${character.name}`);
      return startAgent(character, server);
    };
    server.loadCharacterTryPath = loadCharacterTryPath;
    server.jsonToCharacter = jsonToCharacter;
    logger.info('Server properties set up');

    const serverPort = options.port || Number.parseInt(process.env.SERVER_PORT || '3000');

    let project;
    try {
      logger.info('Attempting to load project or plugin...');
      project = await loadProject(process.cwd());

      if (project.isPlugin) {
        logger.info(`Plugin loaded successfully: ${project.pluginModule?.name}`);
      } else {
        logger.info('Project loaded successfully');
      }

      if (!project || !project.agents || project.agents.length === 0) {
        throw new Error('No agents found in project configuration');
      }

      logger.info(
        `Found ${project.agents.length} agents in ${project.isPlugin ? 'plugin' : 'project'} configuration`
      );
    } catch (error) {
      logger.error('Error loading project/plugin:', error);
      logger.error('Tests cannot run without a valid project or plugin. Exiting.');
      if (error instanceof Error) {
        // If the error is specifically about not finding a project
        if (error.message.includes('Could not find project entry point')) {
          logger.error('No Eliza project or plugin found in current directory.');
          logger.error('Tests can only run in a valid Eliza project or plugin directory.');
        }
        logger.error('Error details:', error.message);
      }
      process.exit(1);
    }

    logger.info('Starting server...');
    try {
      await server.start(serverPort);
      logger.info('Server started successfully');
    } catch (error) {
      logger.error('Error starting server:', error);
      if (error instanceof Error) {
        logger.error('Error details:', error.message);
        logger.error('Stack trace:', error.stack);
      }
      throw error;
    }

    try {
      // Start each agent in sequence
      logger.info(
        `Found ${project.agents.length} agents in ${project.isPlugin ? 'plugin' : 'project'}`
      );

      // When testing a plugin, import and use the default Eliza character
      // to ensure consistency with the start command
      // For projects, only use default agent if no agents are defined
      if (project.isPlugin || project.agents.length === 0) {
        // Set environment variable to signal this is a direct plugin test
        // The TestRunner uses this to identify direct plugin tests
        process.env.ELIZA_TESTING_PLUGIN = 'true';

        logger.info('Using default Eliza character as test agent');
        try {
          // Import the default character (same approach as start.ts)
          const { character: defaultElizaCharacter } = await import('../characters/eliza');

          // Create the list of plugins for testing - exact same approach as start.ts
          const pluginsToTest = [project.pluginModule];

          logger.info(`Starting test agent with plugin: ${project.pluginModule?.name}`);
          logger.debug(
            `Using default character with plugins: ${defaultElizaCharacter.plugins ? defaultElizaCharacter.plugins.join(', ') : 'none'}`
          );
          logger.info(
            "Plugin test mode: Using default character's plugins plus the plugin being tested"
          );

          // Start the agent with the default character and our test plugin
          // Use isPluginTestMode option just like start.ts does
          const runtime = await startAgent(
            defaultElizaCharacter,
            server,
            undefined,
            pluginsToTest,
            {
              isPluginTestMode: true,
            }
          );

          runtimes.push(runtime);
          projectAgents.push({
            character: defaultElizaCharacter,
            plugins: pluginsToTest,
          });

          logger.info('Default test agent started successfully');
        } catch (pluginError) {
          logger.error(`Error starting plugin test agent: ${pluginError}`);
          throw pluginError;
        }
      } else {
        // For regular projects, start each agent as defined
        for (const agent of project.agents) {
          try {
            // Make a copy of the original character to avoid modifying the project configuration
            const originalCharacter = { ...agent.character };

            logger.info(`Starting agent: ${originalCharacter.name}`);

            const runtime = await startAgent(
              originalCharacter,
              server,
              agent.init,
              agent.plugins || []
            );

            runtimes.push(runtime);
            projectAgents.push(agent);

            // wait 1 second between agent starts
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } catch (agentError) {
            logger.error(`Error starting agent ${agent.character.name}:`, agentError);
            if (agentError instanceof Error) {
              logger.error('Error details:', agentError.message);
              logger.error('Stack trace:', agentError.stack);
            }
            // Log the error but don't fail the entire test run
            logger.warn(`Skipping agent ${agent.character.name} due to startup error`);
          }
        }
      }

      if (runtimes.length === 0) {
        throw new Error('Failed to start any agents from project');
      }

      logger.info(`Successfully started ${runtimes.length} agents for testing`);

      // Run tests for each agent
      let totalFailed = 0;
      for (let i = 0; i < runtimes.length; i++) {
        const runtime = runtimes[i];
        const projectAgent = projectAgents[i];

        if (project.isPlugin) {
          logger.info(`Running tests for plugin: ${project.pluginModule?.name}`);
        } else {
          logger.info(`Running tests for agent: ${runtime.character.name}`);
        }

        const testRunner = new TestRunner(runtime, projectAgent);

        // When in a plugin directory, we're testing only the current plugin
        // so we set skipPlugins to true to skip other loaded plugins (like OpenAI)
        // but we allow the current plugin's tests to run via isDirectPluginTest detection
        const skipPlugins = project.isPlugin ? true : options.skipPlugins;

        const results = await testRunner.runTests({
          filter: options.plugin,
          skipPlugins: skipPlugins,
          skipProjectTests: options.skipProjectTests,
        });
        totalFailed += results.failed;
      }

      // Clean up
      await server.stop();
      process.exit(totalFailed > 0 ? 1 : 0);
    } catch (error) {
      logger.error('Error running tests:', error);
      if (error instanceof Error) {
        logger.error('Error details:', error.message);
        logger.error('Stack trace:', error.stack);
      }
      await server.stop();
      throw error;
    }
  } catch (error) {
    logger.error('Error in runAgentTests:', error);
    if (error instanceof Error) {
      logger.error('Error details:', error.message);
      logger.error('Stack trace:', error.stack);
    } else {
      logger.error('Unknown error type:', typeof error);
      logger.error('Error value:', error);
      try {
        logger.error('Stringified error:', JSON.stringify(error, null, 2));
      } catch (e) {
        logger.error('Could not stringify error:', e);
      }
    }
    throw error;
  }
};

// Create command that can be imported directly
export const test = new Command()
  .name('test')
  .description('Run tests for Eliza agent plugins')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .option('-P, --plugin <name>', 'Name of plugin to test')
  .option('--skip-plugins', 'Skip plugin tests')
  .option('--skip-project-tests', 'Skip project tests')
  .option('--skip-build', 'Skip building before running tests')
  .action(async (options) => {
    logger.info('Starting test command...');
    logger.info('Command options:', options);
    try {
      logger.info('Running agent tests...');
      await runAgentTests(options);
    } catch (error) {
      logger.error('Error running tests:', error);
      if (error instanceof Error) {
        logger.error('Error details:', error.message);
        logger.error('Stack trace:', error.stack);
      } else {
        logger.error('Unknown error type:', typeof error);
        logger.error('Error value:', error);
        try {
          logger.error('Stringified error:', JSON.stringify(error, null, 2));
        } catch (e) {
          logger.error('Could not stringify error:', e);
        }
      }
      process.exit(1);
    }
  });

// This is the function that registers the command with the CLI
export default function registerCommand(cli: Command) {
  return cli.addCommand(test);
}
