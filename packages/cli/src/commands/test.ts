import { loadProject } from '@/src/project';
import { AgentServer } from '@/src/server/index';
import { jsonToCharacter, loadCharacterTryPath } from '@/src/server/loader';
import { TestRunner, buildProject, promptForEnvVars } from '@/src/utils';
import { type IAgentRuntime, type ProjectAgent } from '@elizaos/core';
import { Command, Option } from 'commander';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { startAgent } from './start';

const execAsync = promisify(exec);

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
    existsSync(path.join(dir, 'src/plugins.ts')) ||
    (existsSync(path.join(dir, 'src/index.ts')) && !existsSync(path.join(dir, 'src/agent.ts')))
  );
}

/**
 * Run unit tests using Vitest
 */
async function runUnitTests(options: { name?: string; skipBuild?: boolean }) {
  const cwd = process.cwd();

  // Build the project first unless skip-build is specified
  if (!options.skipBuild) {
    console.info('Building project...');
    const isPlugin = checkIfLikelyPluginDir(cwd);
    await buildProject(cwd, isPlugin);
    console.info('Build completed successfully');
  }

  console.info('Running unit tests...');

  try {
    // Construct the vitest command
    let command = 'bun run vitest run';

    // Add filter if specified - Vitest supports both file path filtering and test name filtering
    if (options.name) {
      // First try to match file paths (more specific)
      command += ` "__tests__/**/${options.name}*.test.{js,ts,jsx,tsx}"`;

      // Also allow matching test names with -t (less specific, but more flexible)
      command += ` -t "${options.name}"`;
    }

    const { stdout, stderr } = await execAsync(command);
    console.log(stdout);
    if (stderr) console.error(stderr);

    console.info('Unit tests completed');

    // Check if there were test failures in the output
    if (stdout.includes('FAIL') || stderr?.includes('FAIL')) {
      return { failed: true };
    }

    return { failed: false };
  } catch (error) {
    console.error('Error running unit tests:', error);
    return { failed: true };
  }
}

/**
 * Function that runs the end-to-end tests.
 */
const runE2eTests = async (options: { port?: number; name?: string; skipBuild?: boolean }) => {
  // Build the project or plugin first unless skip-build is specified
  if (!options.skipBuild) {
    try {
      const cwd = process.cwd();
      const isPlugin = checkIfLikelyPluginDir(cwd);
      console.info(`Building ${isPlugin ? 'plugin' : 'project'}...`);
      await buildProject(cwd, isPlugin);
      console.info(`Build completed successfully`);
    } catch (buildError) {
      console.error(`Build error: ${buildError}`);
      console.warn(`Attempting to continue with tests despite build error`);
    }
  }

  try {
    const runtimes: IAgentRuntime[] = [];
    const projectAgents: ProjectAgent[] = [];

    // Set up standard paths and load .env
    const homeDir = os.homedir();
    const elizaDir = path.join(homeDir, '.eliza');
    const elizaDbDir = path.join(elizaDir, 'db');
    const envFilePath = path.join(process.cwd(), '.env');

    console.info('Setting up environment...');
    console.info(`Home directory: ${homeDir}`);
    console.info(`Eliza directory: ${elizaDir}`);
    console.info(`Database directory: ${elizaDbDir}`);
    console.info(`Environment file: ${envFilePath}`);

    // Create db directory if it doesn't exist
    if (!fs.existsSync(elizaDbDir)) {
      console.info(`Creating database directory: ${elizaDbDir}`);
      fs.mkdirSync(elizaDbDir, { recursive: true });
      console.info(`Created database directory: ${elizaDbDir}`);
    }

    // Set the database directory in environment variables
    process.env.PGLITE_DATA_DIR = elizaDbDir;
    console.info(`Using database directory: ${elizaDbDir}`);

    // Load environment variables from project .env if it exists
    if (fs.existsSync(envFilePath)) {
      console.info(`Loading environment variables from: ${envFilePath}`);
      dotenv.config({ path: envFilePath });
      console.info('Environment variables loaded');
    } else {
      console.warn(`Environment file not found: ${envFilePath}`);
    }

    // Always ensure database configuration is set
    try {
      console.info('Configuring database...');
      await promptForEnvVars('pglite');
      console.info('Database configuration completed');
    } catch (error) {
      console.error('Error configuring database:', error);
      if (error instanceof Error) {
        console.error('Error details:', error.message);
        console.error('Stack trace:', error.stack);
      }
      throw error;
    }

    // Look for PostgreSQL URL in environment variables
    const postgresUrl = process.env.POSTGRES_URL;
    console.info(`PostgreSQL URL: ${postgresUrl ? 'found' : 'not found'}`);

    // Create server instance
    console.info('Creating server instance...');
    const server = new AgentServer({
      dataDir: elizaDbDir,
      postgresUrl,
    });
    console.info('Server instance created');

    // Wait for database initialization
    console.info('Waiting for database initialization...');

    // Initialize the server explicitly before starting
    console.info('Initializing server...');
    try {
      await server.initialize();
      console.info('Server initialized successfully');
    } catch (initError) {
      console.error('Server initialization failed:', initError);
      throw initError;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        let initializationAttempts = 0;
        const maxAttempts = 5;
        const checkInterval = setInterval(async () => {
          try {
            // Check if the database is already initialized
            if (await server.database?.getConnection()) {
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
              console.warn(
                `Database initialization attempt ${initializationAttempts}/${maxAttempts} failed:`,
                initError
              );

              // Check if we've reached the maximum attempts
              if (initializationAttempts >= maxAttempts) {
                if (await server.database?.getConnection()) {
                  // If we have a connection, consider it good enough even with migration errors
                  console.warn(
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
            console.error('Error during database initialization check:', error);
            if (error instanceof Error) {
              console.error('Error details:', error.message);
              console.error('Stack trace:', error.stack);
            }
            clearInterval(checkInterval);
            reject(error);
          }
        }, 1000);

        // Timeout after 30 seconds
        setTimeout(async () => {
          clearInterval(checkInterval);
          if (await server.database?.getConnection()) {
            // If we have a connection, consider it good enough even with initialization issues
            console.warn(
              'Database initialization timeout, but connection exists. Proceeding anyway.'
            );
            resolve();
          } else {
            reject(new Error('Database initialization timed out after 30 seconds'));
          }
        }, 30000);
      });
      console.info('Database initialized successfully');
    } catch (error) {
      console.error('Failed to initialize database:', error);
      if (error instanceof Error) {
        console.error('Error details:', error.message);
        console.error('Stack trace:', error.stack);
      }
      throw error;
    }

    // Set up server properties
    console.info('Setting up server properties...');
    server.startAgent = async (character) => {
      console.info(`Starting agent for character ${character.name}`);
      return startAgent(character, server);
    };
    server.loadCharacterTryPath = loadCharacterTryPath;
    server.jsonToCharacter = jsonToCharacter;
    console.info('Server properties set up');

    const serverPort = options.port || Number.parseInt(process.env.SERVER_PORT || '3000');

    let project;
    try {
      console.info('Attempting to load project or plugin...');
      project = await loadProject(process.cwd());

      if (project.isPlugin) {
        console.info(`Plugin loaded successfully: ${project.pluginModule?.name}`);
      } else {
        console.info('Project loaded successfully');
      }

      if (!project || !project.agents || project.agents.length === 0) {
        throw new Error('No agents found in project configuration');
      }

      console.info(
        `Found ${project.agents.length} agents in ${project.isPlugin ? 'plugin' : 'project'} configuration`
      );
    } catch (error) {
      console.error('Error loading project/plugin:', error);
      console.error('Tests cannot run without a valid project or plugin. Exiting.');
      if (error instanceof Error) {
        // If the error is specifically about not finding a project
        if (error.message.includes('Could not find project entry point')) {
          console.error('No Eliza project or plugin found in current directory.');
          console.error('Tests can only run in a valid Eliza project or plugin directory.');
        }
        console.error('Error details:', error.message);
      }
      process.exit(1);
    }

    console.info('Starting server...');
    try {
      await server.start(serverPort);
      console.info('Server started successfully');
    } catch (error) {
      console.error('Error starting server:', error);
      if (error instanceof Error) {
        console.error('Error details:', error.message);
        console.error('Stack trace:', error.stack);
      }
      throw error;
    }

    try {
      // Start each agent in sequence
      console.info(
        `Found ${project.agents.length} agents in ${project.isPlugin ? 'plugin' : 'project'}`
      );

      // When testing a plugin, import and use the default Eliza character
      // to ensure consistency with the start command
      // For projects, only use default agent if no agents are defined
      if (project.isPlugin || project.agents.length === 0) {
        // Set environment variable to signal this is a direct plugin test
        // The TestRunner uses this to identify direct plugin tests
        process.env.ELIZA_TESTING_PLUGIN = 'true';

        console.info('Using default Eliza character as test agent');
        try {
          // Import the default character (same approach as start.ts)
          const { character: defaultElizaCharacter } = await import('../characters/eliza');

          // Create the list of plugins for testing - exact same approach as start.ts
          const pluginsToTest = [project.pluginModule];

          console.info(`Starting test agent with plugin: ${project.pluginModule?.name}`);
          console.debug(
            `Using default character with plugins: ${defaultElizaCharacter.plugins ? defaultElizaCharacter.plugins.join(', ') : 'none'}`
          );
          console.info(
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

          console.info('Default test agent started successfully');
        } catch (pluginError) {
          console.error(`Error starting plugin test agent: ${pluginError}`);
          throw pluginError;
        }
      } else {
        // For regular projects, start each agent as defined
        for (const agent of project.agents) {
          try {
            // Make a copy of the original character to avoid modifying the project configuration
            const originalCharacter = { ...agent.character };

            console.debug(`Starting agent: ${originalCharacter.name}`);

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
            console.error(`Error starting agent ${agent.character.name}:`, agentError);
            if (agentError instanceof Error) {
              console.error('Error details:', agentError.message);
              console.error('Stack trace:', agentError.stack);
            }
            // Log the error but don't fail the entire test run
            console.warn(`Skipping agent ${agent.character.name} due to startup error`);
          }
        }
      }

      if (runtimes.length === 0) {
        throw new Error('Failed to start any agents from project');
      }

      console.debug(`Successfully started ${runtimes.length} agents for testing`);

      // Run tests for each agent
      let totalFailed = 0;
      for (let i = 0; i < runtimes.length; i++) {
        const runtime = runtimes[i];
        const projectAgent = projectAgents[i];

        if (project.isPlugin) {
          console.debug(`Running tests for plugin: ${project.pluginModule?.name}`);
        } else {
          console.debug(`Running tests for agent: ${runtime.character.name}`);
        }

        const testRunner = new TestRunner(runtime, projectAgent);

        // When in a plugin directory, we're testing only the current plugin
        // so we set skipPlugins to true to skip other loaded plugins (like OpenAI)
        // but we allow the current plugin's tests to run via isDirectPluginTest detection
        const skipPlugins = project.isPlugin;

        const results = await testRunner.runTests({
          filter: options.name, // Use name for filtering
          skipPlugins: skipPlugins,
          skipProjectTests: false,
        });
        totalFailed += results.failed;
      }

      // Clean up
      await server.stop();
      return { failed: totalFailed > 0 };
    } catch (error) {
      console.error('Error running tests:', error);
      if (error instanceof Error) {
        console.error('Error details:', error.message);
        console.error('Stack trace:', error.stack);
      }
      await server.stop();
      throw error;
    }
  } catch (error) {
    console.error('Error in runE2eTests:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
      console.error('Stack trace:', error.stack);
    } else {
      console.error('Unknown error type:', typeof error);
      console.error('Error value:', error);
      try {
        console.error('Stringified error:', JSON.stringify(error, null, 2));
      } catch (e) {
        console.error('Could not stringify error:', e);
      }
    }
    return { failed: true };
  }
};

/**
 * Run both unit and E2E tests
 */
async function runAllTests(options: { port?: number; name?: string; skipBuild?: boolean }) {
  // Run unit tests first
  const unitResult = await runUnitTests(options);

  // Run e2e tests
  const e2eResult = await runE2eTests(options);

  // Return combined result
  return { failed: unitResult.failed || e2eResult.failed };
}

// Create base test command with basic description only
export const test = new Command()
  .name('test')
  .description('Run tests for Eliza agent projects and plugins');

// Add subcommands first
test
  .command('unit')
  .description('Run unit tests (via Vitest)')
  .action(async (_, cmd) => {
    // Get options from parent command
    const options = {
      name: cmd.parent.opts().name,
      skipBuild: cmd.parent.opts().skipBuild,
    };

    console.info('Starting unit tests...');
    console.info('Command options:', options);

    try {
      const result = await runUnitTests(options);
      process.exit(result.failed ? 1 : 0);
    } catch (error) {
      console.error('Error running unit tests:', error);
      process.exit(1);
    }
  });

test
  .command('e2e')
  .description('Run end-to-end runtime tests')
  .action(async (_, cmd) => {
    // Get options from parent command
    const options = {
      port: cmd.parent.opts().port,
      name: cmd.parent.opts().name,
      skipBuild: cmd.parent.opts().skipBuild,
    };

    console.info('Starting e2e tests...');
    console.info('Command options:', options);

    try {
      const result = await runE2eTests(options);
      process.exit(result.failed ? 1 : 0);
    } catch (error) {
      console.error('Error running e2e tests:', error);
      process.exit(1);
    }
  });

test
  .command('all', { isDefault: true })
  .description('Run both unit and e2e tests (default)')
  .action(async (_, cmd) => {
    // Get options from parent command
    const options = {
      port: cmd.parent.opts().port,
      name: cmd.parent.opts().name,
      skipBuild: cmd.parent.opts().skipBuild,
    };

    console.info('Starting all tests...');
    console.info('Command options:', options);

    try {
      const result = await runAllTests(options);
      process.exit(result.failed ? 1 : 0);
    } catch (error) {
      console.error('Error running tests:', error);
      process.exit(1);
    }
  });

// Add options after subcommands
test
  .addOption(
    new Option('-p, --port <port>', 'Server port for e2e tests').argParser((val) =>
      Number.parseInt(val)
    )
  )
  .option('-n, --name <name>', 'Filter tests by name (matches file names or test suite names)')
  .option('--skip-build', 'Skip building before running tests');

// This is the function that registers the command with the CLI
export default function registerCommand(cli: Command) {
  return cli.addCommand(test);
}
