import { loadProject } from '@/src/project';
import { AgentServer } from '@/src/server/index';
import { jsonToCharacter, loadCharacterTryPath } from '@/src/server/loader';
import {
  TestRunner,
  buildProject,
  promptForEnvVars,
  resolveEnvFile,
  resolvePgliteDir,
} from '@/src/utils';
import { type IAgentRuntime, type ProjectAgent } from '@elizaos/core';
import { Command, Option } from 'commander';
import * as dotenv from 'dotenv';
import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import * as net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'url';
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
 * Process filter name to remove extensions consistently
 *
 * Note: Test filtering works in two ways:
 * 1. Matching test suite names (the string in describe() blocks)
 * 2. Matching file names (without extension)
 *
 * For best results, use the specific test suite name you want to run.
 * The filter is applied case-insensitively for better user experience.
 */
function processFilterName(name?: string): string | undefined {
  if (!name) return undefined;

  // Handle common filter formats (case-insensitive)
  let baseName = name.toLowerCase();

  if (
    baseName.endsWith('.test.ts') ||
    baseName.endsWith('.test.js') ||
    baseName.endsWith('.spec.ts') ||
    baseName.endsWith('.spec.js')
  ) {
    baseName = baseName.slice(0, -8); // Remove '.test.ts' / '.test.js' / '.spec.ts' / '.spec.js'
  } else if (baseName.endsWith('.test') || baseName.endsWith('.spec')) {
    baseName = baseName.slice(0, -5); // Remove '.test' / '.spec'
  }

  return baseName;
}

/**
 * Run component tests using Vitest
 */
async function runComponentTests(options: { name?: string; skipBuild?: boolean }) {
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

  console.info('Running component tests...');

  try {
    // Use safer approach to avoid command injection
    const execa = await import('execa');
    const args = ['run', 'vitest', 'run'];

    // Add filter if specified
    if (options.name) {
      const baseName = processFilterName(options.name);
      console.info(`Using test filter: ${baseName}`);

      // Add filter as separate arguments
      args.push('-t', baseName);
    }

    const { stdout, stderr } = await execa.execaCommand(`bun ${args.join(' ')}`, {
      maxBuffer: 10 * 1024 * 1024,
      shell: true,
    });
    console.log(stdout);
    if (stderr) console.error(stderr);

    console.info('Component tests completed');

    // Check if there were test failures in the output
    if (stdout.includes('FAIL') || stderr?.includes('FAIL')) {
      return { failed: true };
    }

    return { failed: false };
  } catch (error) {
    console.error('Error running component tests:', error);
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
    const elizaDir = path.join(process.cwd(), '.eliza');
    const elizaDbDir = await resolvePgliteDir();
    const envFilePath = resolveEnvFile();

    console.info('Setting up environment...');
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
    const server = new AgentServer();
    console.info('Server instance created');

    // Wait for database initialization
    console.info('Waiting for database initialization...');

    // Initialize the server explicitly before starting
    console.info('Initializing server...');
    try {
      await server.initialize({
        dataDir: elizaDbDir,
        postgresUrl,
      });
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
      try {
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
      } catch (loadError) {
        console.error('Error loading project/plugin:', loadError);

        // For testing purposes, let's try to find the dist version of index.js
        const distIndexPath = path.join(process.cwd(), 'dist', 'index.js');
        if (fs.existsSync(distIndexPath)) {
          try {
            console.info(`Attempting to load project from dist/index.js instead...`);
            const distModule = await import(pathToFileURL(distIndexPath).href);
            if (distModule && (distModule.default || distModule.character || distModule.plugin)) {
              console.info(`Successfully loaded project from dist/index.js`);

              // Create a minimal project structure
              project = {
                isPlugin: Boolean(distModule.plugin || distModule.default?.plugin),
                agents: [
                  {
                    character: distModule.character ||
                      distModule.default?.character || { name: 'Test Character' },
                    plugins: distModule.plugin
                      ? [distModule.plugin]
                      : distModule.default?.plugin
                        ? [distModule.default.plugin]
                        : [],
                  },
                ],
              };

              console.info(`Created project with ${project.agents.length} agents`);
            } else {
              throw new Error(`dist/index.js exists but doesn't export expected properties`);
            }
          } catch (distError) {
            console.error(`Failed to load from dist/index.js:`, distError);
            throw loadError; // Rethrow the original error
          }
        } else {
          console.error('Tests cannot run without a valid project or plugin. Exiting.');
          if (loadError instanceof Error) {
            // If the error is specifically about not finding a project
            if (loadError.message.includes('Could not find project entry point')) {
              console.error('No Eliza project or plugin found in current directory.');
              console.error('Tests can only run in a valid Eliza project or plugin directory.');
            }
            console.error('Error details:', loadError.message);
          }
          process.exit(1);
        }
      }

      console.info('Starting server...');
      try {
        // Check if the port is available first
        if (!(await checkPortAvailable(serverPort))) {
          console.error(`Port ${serverPort} is already in use. Choose another with --port.`);
          throw new Error(`Port ${serverPort} is already in use`);
        }

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
        try {
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

            // Process filter name consistently
            const processedFilter = processFilterName(options.name);

            const results = await testRunner.runTests({
              filter: processedFilter, // Use processed name for filtering
              skipPlugins: skipPlugins,
              skipProjectTests: false,
            });
            totalFailed += results.failed;
          }

          return { failed: totalFailed > 0 };
        } catch (error) {
          console.error('Error running tests:', error);
          if (error instanceof Error) {
            console.error('Error details:', error.message);
            console.error('Stack trace:', error.stack);
          }
          throw error;
        } finally {
          // Clean up - ensure server is always stopped
          await server.stop();
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
 * Run both component and E2E tests
 */
async function runAllTests(options: { port?: number; name?: string; skipBuild?: boolean }) {
  // Run component tests first
  const componentResult = await runComponentTests(options);

  // Run e2e tests with the same processed filter name
  // Skip the second build since we already built for component tests
  const e2eResult = await runE2eTests({ ...options, skipBuild: true });

  // Return combined result
  return { failed: componentResult.failed || e2eResult.failed };
}

// Create base test command with basic description only
export const test = new Command()
  .name('test')
  .description('Run tests for Eliza agent projects and plugins');

// Add subcommands first
test
  .command('component')
  .description('Run component tests (via Vitest)')
  .action(async (_, cmd) => {
    // Get options from parent command
    const options = {
      name: cmd.parent.opts().name,
      skipBuild: cmd.parent.opts().skipBuild,
    };

    console.info('Starting component tests...');
    console.info('Command options:', options);

    try {
      const result = await runComponentTests(options);
      process.exit(result.failed ? 1 : 0);
    } catch (error) {
      console.error('Error running component tests:', error);
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
  .description('Run both component and e2e tests (default)')
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
  .option('-n, --name <n>', 'Filter tests by name (matches file names or test suite names)')
  .option('--skip-build', 'Skip building before running tests');

// This is the function that registers the command with the CLI
export default function registerCommand(cli: Command) {
  return cli.addCommand(test);
}
