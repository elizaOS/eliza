import { loadProject } from '@/src/project';
import { AgentServer } from '@/src/server/index';
import { jsonToCharacter, loadCharacterTryPath } from '@/src/server/loader';
import {
  TestRunner,
  buildProject,
  promptForEnvVars,
  resolvePgliteDir,
  UserEnvironment,
} from '@/src/utils';
import { detectDirectoryType, type DirectoryInfo } from '@/src/utils/directory-detection';
import { validatePort } from '@/src/utils/port-validation';
import { type IAgentRuntime, type ProjectAgent } from '@elizaos/core';
import { Command, Option } from 'commander';
import * as dotenv from 'dotenv';
import { exec, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import * as net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'url';
import { startAgent } from './start';
import { getElizaCharacter } from '../characters/eliza';
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
 * Determines the project type using comprehensive directory detection
 */
function getProjectType(): DirectoryInfo {
  return detectDirectoryType(process.cwd());
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
async function runComponentTests(
  options: { name?: string; skipBuild?: boolean },
  projectInfo: DirectoryInfo
): Promise<{ failed: boolean }> {
  // Build the project or plugin first unless skip-build is specified
  if (!options.skipBuild) {
    try {
      const cwd = process.cwd();
      const isPlugin = projectInfo.type === 'elizaos-plugin';
      console.info(`Building ${isPlugin ? 'plugin' : 'project'}...`);
      await buildProject(cwd, isPlugin);
      console.info(`Build completed successfully`);
    } catch (buildError) {
      console.error(`Build error: ${buildError}`);
      console.warn(`Attempting to continue with tests despite build error`);
    }
  }

  console.info('Running component tests...');

  return new Promise((resolve) => {
    // Build command arguments
    const args = ['run', 'vitest', 'run', '--passWithNoTests', '--reporter=default'];

    // Add filter if specified
    if (options.name) {
      const baseName = processFilterName(options.name);
      console.info(`Using test filter: ${baseName}`);
      args.push('-t', baseName);
    }

    console.info('Executing: bun', args.join(' '));

    // Use spawn for real-time output streaming
    const child = spawn('bun', args, {
      stdio: 'inherit',
      shell: false,
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORCE_COLOR: '1', // Force color output
        CI: 'false', // Ensure we're not in CI mode which might buffer
      },
    });

    child.on('close', (code) => {
      console.info('Component tests completed');
      resolve({ failed: code !== 0 });
    });

    child.on('error', (error) => {
      console.error('Error running component tests:', error);
      resolve({ failed: true });
    });
  });
}

/**
 * Function that runs the end-to-end tests.
 */
const runE2eTests = async (
  options: { port?: number; name?: string; skipBuild?: boolean },
  projectInfo: DirectoryInfo
) => {
  // Build the project or plugin first unless skip-build is specified
  if (!options.skipBuild) {
    try {
      const cwd = process.cwd();
      const isPlugin = projectInfo.type === 'elizaos-plugin';
      console.info(`Building ${isPlugin ? 'plugin' : 'project'}...`);
      await buildProject(cwd, isPlugin);
      console.info(`Build completed successfully`);
    } catch (buildError) {
      console.error(`Build error: ${buildError}`);
      console.warn(`Attempting to continue with tests despite build error`);
    }
  }

  let server: AgentServer | undefined;
  try {
    const runtimes: IAgentRuntime[] = [];
    const projectAgents: ProjectAgent[] = [];

    // Set up standard paths and load .env
    const elizaDir = path.join(process.cwd(), '.eliza');
    // Create unique database directory for each test run to avoid conflicts
    const packageName = path.basename(process.cwd());
    const timestamp = Date.now();
    const uniqueDbDir = path.join(process.cwd(), '.elizadb-test', `${packageName}-${timestamp}`);
    const elizaDbDir = uniqueDbDir;
    const envInfo = await UserEnvironment.getInstanceInfo();
    const envFilePath = envInfo.paths.envFilePath;

    console.info('Setting up environment...');
    console.info(`Eliza directory: ${elizaDir}`);
    console.info(`Database directory: ${elizaDbDir}`);
    console.info(`Environment file: ${envFilePath}`);
    console.info(`Package name: ${packageName}, Timestamp: ${timestamp}`);

    // Clean up any existing database directory to prevent corruption
    if (fs.existsSync(elizaDbDir)) {
      console.info(`Cleaning up existing database directory: ${elizaDbDir}`);
      try {
        fs.rmSync(elizaDbDir, { recursive: true, force: true });
        console.info(`Successfully cleaned up existing database directory`);
      } catch (error) {
        console.warn(`Failed to clean up existing database directory: ${error}`);
        // Continue anyway, the initialization might handle it
      }
    }

    // Create fresh db directory
    console.info(`Creating fresh database directory: ${elizaDbDir}`);
    fs.mkdirSync(elizaDbDir, { recursive: true });
    console.info(`Created database directory: ${elizaDbDir}`);

    // Set the database directory in environment variables to ensure it's used
    process.env.PGLITE_DATA_DIR = elizaDbDir;
    console.info(`Set PGLITE_DATA_DIR to: ${elizaDbDir}`);

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
      await promptForEnvVars('pglite'); // This ensures PGLITE_DATA_DIR is set if not already
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
    console.info(
      `PostgreSQL URL for e2e tests: ${postgresUrl ? 'found' : 'not found (will use PGlite)'}`
    );

    // Create server instance
    console.info('Creating server instance...');
    server = new AgentServer();
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
          // Throw the original loadError to be caught by the outer try-catch,
          // which will then ensure server.stop() is called.
          console.error('Tests cannot run without a valid project or plugin.');
          if (loadError instanceof Error) {
            if (
              loadError.message.includes('Could not find project entry point') ||
              loadError.message.includes('No main field')
            ) {
              console.error(
                'No Eliza project or plugin found in current directory, or package.json is missing a "main" field.'
              );
              console.error(
                'Tests can only run in a valid Eliza project or plugin directory with a valid package.json.'
              );
            }
          }
          throw loadError; // Propagate error
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
            const defaultElizaCharacter = getElizaCharacter();

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
        let anyTestsFound = false;
        for (let i = 0; i < runtimes.length; i++) {
          const runtime = runtimes[i];
          const projectAgent = projectAgents[i];

          if (project.isPlugin) {
            console.debug(`Running tests for plugin: ${project.pluginModule?.name}`);
          } else {
            console.debug(`Running tests for agent: ${runtime.character.name}`);
          }

          const testRunner = new TestRunner(runtime, projectAgent);

          // Determine what types of tests to run based on directory type
          const currentDirInfo = projectInfo;

          // Process filter name consistently
          const processedFilter = processFilterName(options.name);

          const results = await testRunner.runTests({
            filter: processedFilter,
            // Only run plugin tests if we're actually in a plugin directory
            skipPlugins: currentDirInfo.type !== 'elizaos-plugin',
            // Only run project tests if we're actually in a project directory
            skipProjectTests: currentDirInfo.type !== 'elizaos-project',
            skipE2eTests: false, // Always allow E2E tests
          });
          totalFailed += results.failed;
          if (results.hasTests) {
            anyTestsFound = true;
          }
        }

        // Return success (false) if no tests were found, or if tests ran but none failed
        // This aligns with standard testing tools like vitest/jest behavior
        return { failed: anyTestsFound ? totalFailed > 0 : false };
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
      } finally {
        // Clean up database directory after tests complete
        try {
          if (fs.existsSync(elizaDbDir)) {
            console.info(`Cleaning up test database directory: ${elizaDbDir}`);
            fs.rmSync(elizaDbDir, { recursive: true, force: true });
            console.info(`Successfully cleaned up test database directory`);
          }
          // Also clean up the parent test directory if it's empty
          const testDir = path.dirname(elizaDbDir);
          if (fs.existsSync(testDir) && fs.readdirSync(testDir).length === 0) {
            fs.rmSync(testDir, { recursive: true, force: true });
          }
        } catch (cleanupError) {
          console.warn(`Failed to clean up test database directory: ${cleanupError}`);
          // Don't fail the test run due to cleanup issues
        }
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
  const projectInfo = getProjectType();
  const componentResult = await runComponentTests(options, projectInfo);

  // Run e2e tests with the same processed filter name
  // Skip the second build since we already built for component tests
  const e2eResult = await runE2eTests({ ...options, skipBuild: true }, projectInfo);

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
      const projectInfo = getProjectType();
      const result = await runComponentTests(options, projectInfo);
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
      const projectInfo = getProjectType();
      const result = await runE2eTests(options, projectInfo);
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
      const projectInfo = getProjectType();
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
    new Option('-p, --port <port>', 'Server port for e2e tests (default: 3000)').argParser(
      validatePort
    )
  )
  .option('-n, --name <n>', 'Filter tests by name (matches file names or test suite names)')
  .option('--skip-build', 'Skip building before running tests');

// This is the function that registers the command with the CLI
export default function registerCommand(cli: Command) {
  return cli.addCommand(test);
}
