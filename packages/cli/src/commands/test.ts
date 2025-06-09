import { loadProject } from '@/src/project';
import { AgentServer } from '@/src/server/index';
import { jsonToCharacter, loadCharacterTryPath } from '@/src/server/loader';
import {
  buildProject,
  findNextAvailablePort,
  getCliInstallTag,
  installPlugin,
  loadPluginModule,
  promptForEnvVars,
  resolvePgliteDir,
  TestRunner,
  UserEnvironment,
  handleError,
} from '@/src/utils';
import { detectDirectoryType, type DirectoryInfo } from '@/src/utils/directory-detection';
import { detectPluginContext, provideLocalPluginGuidance } from '@/src/utils/plugin-context';
import {
  AgentRuntime,
  logger,
  type IAgentRuntime,
  type Plugin,
  type ProjectAgent,
} from '@elizaos/core';
import { Command, Option } from 'commander';
import * as dotenv from 'dotenv';
import { exec, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import which from 'which';
import { getElizaCharacter } from '../characters/eliza';
import { validatePort } from '../utils/port-validation';
import { startAgent } from './start';
import { plugin as sqlPlugin } from '@elizaos/plugin-sql';
// import { findNextAvailablePort as portHandlingFindNextAvailablePort } from './port-handling';
const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Loads the plugin modules for a plugin's dependencies.
 * Assumes dependencies have already been installed by `installPluginDependencies`.
 * @param projectInfo Information about the current directory
 * @returns An array of loaded plugin modules.
 */
async function loadPluginDependencies(projectInfo: DirectoryInfo): Promise<Plugin[]> {
  if (projectInfo.type !== 'elizaos-plugin') {
    return [];
  }
  const project = await loadProject(process.cwd());
  const dependencyPlugins: Plugin[] = [];

  if (project.isPlugin && project.pluginModule?.dependencies?.length > 0) {
    const projectPluginsPath = path.join(process.cwd(), '.eliza', 'plugins');
    for (const dependency of project.pluginModule.dependencies) {
      const pluginPath = path.join(projectPluginsPath, 'node_modules', dependency);
      if (fs.existsSync(pluginPath)) {
        try {
          // Dependencies from node_modules are pre-built. We just need to load them.
          const pluginProject = await loadProject(pluginPath);
          if (pluginProject.pluginModule) {
            dependencyPlugins.push(pluginProject.pluginModule);
          }
        } catch (error) {
          logger.error(`Failed to load or build dependency ${dependency}:`, error);
        }
      }
    }
  }
  return dependencyPlugins;
}

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
function getProjectType(testPath?: string): DirectoryInfo {
  const targetPath = testPath ? path.resolve(process.cwd(), testPath) : process.cwd();
  return detectDirectoryType(targetPath);
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
  testPath: string | undefined,
  options: { name?: string; skipBuild?: boolean },
  projectInfo: DirectoryInfo
): Promise<{ failed: boolean }> {
  // Build the project or plugin first unless skip-build is specified
  if (!options.skipBuild) {
    try {
      const cwd = process.cwd();
      const isPlugin = projectInfo.type === 'elizaos-plugin';
      logger.info(`Building ${isPlugin ? 'plugin' : 'project'}...`);
      await buildProject(cwd, isPlugin);
      logger.info(`Build completed successfully`);
    } catch (buildError) {
      logger.error(`Build error: ${buildError}`);
      logger.warn(`Attempting to continue with tests despite build error`);
    }
  }

  logger.info('Running component tests...');

  return new Promise((resolve) => {
    // Build command arguments
    const args = ['run', 'vitest', 'run', '--passWithNoTests', '--reporter=default'];

    // Add filter if specified
    if (options.name) {
      const baseName = processFilterName(options.name);
      logger.info(`Using test filter: ${baseName}`);
      args.push('-t', baseName);
    }

    const targetPath = testPath ? path.resolve(process.cwd(), '..', testPath) : process.cwd();
    logger.info(`Executing: bun ${args.join(' ')} in ${targetPath}`);

    // Use spawn for real-time output streaming
    const child = spawn('bun', args, {
      stdio: 'inherit',
      shell: false,
      cwd: targetPath,
      env: {
        ...process.env,
        FORCE_COLOR: '1', // Force color output
        CI: 'false', // Ensure we're not in CI mode which might buffer
      },
    });

    child.on('close', (code) => {
      logger.info('Component tests completed');
      resolve({ failed: code !== 0 });
    });

    child.on('error', (error) => {
      logger.error('Error running component tests:', error);
      resolve({ failed: true });
    });
  });
}

function findMonorepoRoot(startDir: string): string {
  let currentDir = startDir;
  while (currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, 'lerna.json'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  throw new Error(
    'Could not find monorepo root. Make sure to run tests from within the Eliza project.'
  );
}

/**
 * Function that runs the end-to-end tests.
 */
const runE2eTests = async (
  testPath: string | undefined,
  options: { port?: number; name?: string; skipBuild?: boolean },
  projectInfo: DirectoryInfo
) => {
  // Build the project or plugin first unless skip-build is specified
  if (!options.skipBuild) {
    try {
      const cwd = process.cwd();
      const isPlugin = projectInfo.type === 'elizaos-plugin';
      logger.info(`Building ${isPlugin ? 'plugin' : 'project'}...`);
      await buildProject(cwd, isPlugin);
      logger.info(`Build completed successfully`);
    } catch (buildError) {
      logger.error(`Build error: ${buildError}`);
      logger.warn(`Attempting to continue with tests despite build error`);
    }
  }

  let server: AgentServer | undefined;
  try {
    const runtimes: IAgentRuntime[] = [];
    const projectAgents: ProjectAgent[] = [];

    // Set up standard paths and load .env
    const elizaDir = path.join(process.cwd(), '.eliza');
    const elizaDbDir = await resolvePgliteDir();
    const envInfo = await UserEnvironment.getInstanceInfo();
    const envFilePath = envInfo.paths.envFilePath;

    logger.info('Setting up environment...');
    logger.info(`Eliza directory: ${elizaDir}`);
    logger.info(`Database directory: ${elizaDbDir}`);
    logger.info(`Environment file: ${envFilePath}`);

    // Create db directory if it doesn't exist
    if (!fs.existsSync(elizaDbDir)) {
      logger.info(`Creating database directory: ${elizaDbDir}`);
      fs.mkdirSync(elizaDbDir, { recursive: true });
      logger.info(`Created database directory: ${elizaDbDir}`);
    }

    // Set the database directory in environment variables
    process.env.PGLITE_DATA_DIR = elizaDbDir;
    logger.info(`Using database directory: ${elizaDbDir}`);

    // Load environment variables from project .env if it exists
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
      await promptForEnvVars('pglite'); // This ensures PGLITE_DATA_DIR is set if not already
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
    logger.info(
      `PostgreSQL URL for e2e tests: ${postgresUrl ? 'found' : 'not found (will use PGlite)'}`
    );

    // Create server instance
    logger.info('Creating server instance...');
    server = new AgentServer();
    logger.info('Server instance created');

    // Initialize the server explicitly before starting
    logger.info('Initializing server...');
    try {
      await server.initialize({
        dataDir: elizaDbDir,
        postgresUrl,
      });
      logger.info('Server initialized successfully');
    } catch (initError) {
      logger.error('Server initialization failed:', initError);
      throw initError;
    }

    let project;
    try {
      logger.info('Attempting to load project or plugin...');
      // Resolve path from monorepo root, not cwd
      const monorepoRoot = findMonorepoRoot(process.cwd());
      const targetPath = testPath ? path.resolve(monorepoRoot, testPath) : process.cwd();
      project = await loadProject(targetPath);

      if (!project || !project.agents || project.agents.length === 0) {
        throw new Error('No agents found in project configuration');
      }

      logger.info(
        `Found ${project.agents.length} agents in ${project.isPlugin ? 'plugin' : 'project'} configuration`
      );

      // Set up server properties
      logger.info('Setting up server properties...');
      server.startAgent = async (character) => {
        logger.info(`Starting agent for character ${character.name}`);
        return startAgent(character, server, undefined, [], { isTestMode: true });
      };
      server.loadCharacterTryPath = loadCharacterTryPath;
      server.jsonToCharacter = jsonToCharacter;
      logger.info('Server properties set up');

      const desiredPort = options.port || Number.parseInt(process.env.SERVER_PORT || '3000');
      const serverPort = await findNextAvailablePort(desiredPort);

      if (serverPort !== desiredPort) {
        logger.warn(`Port ${desiredPort} is in use for testing, using port ${serverPort} instead.`);
      }

      logger.info('Starting server...');
      try {
        await server.start(serverPort);
        logger.info('Server started successfully on port', serverPort);
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
            const pluginUnderTest = project.pluginModule;
            if (!pluginUnderTest) {
              throw new Error('Plugin module could not be loaded for testing.');
            }
            const defaultElizaCharacter = getElizaCharacter();

            // The startAgent function now handles all dependency resolution,
            // including testDependencies when isTestMode is true.
            const runtime = await startAgent(
              defaultElizaCharacter,
              server,
              undefined, // No custom init for default test setup
              [pluginUnderTest], // Pass the local plugin module directly
              { isTestMode: true }
            );

            server.registerAgent(runtime); // Ensure server knows about the runtime
            runtimes.push(runtime);
            projectAgents.push({
              character: defaultElizaCharacter,
              plugins: runtime.plugins,
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

              logger.debug(`Starting agent: ${originalCharacter.name}`);

              const runtime = await startAgent(
                originalCharacter,
                server,
                agent.init,
                agent.plugins || [],
                { isTestMode: true } // Pass isTestMode for project tests as well
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

        logger.debug(`Successfully started ${runtimes.length} agents for testing`);

        // Run tests for each agent
        let totalFailed = 0;
        let anyTestsFound = false;
        for (let i = 0; i < runtimes.length; i++) {
          const runtime = runtimes[i];
          const projectAgent = projectAgents[i];

          if (project.isPlugin) {
            logger.debug(`Running tests for plugin: ${project.pluginModule?.name}`);
          } else {
            logger.debug(`Running tests for agent: ${runtime.character.name}`);
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
        logger.error('Error in runE2eTests:', error);
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
        return { failed: true };
      }
    } catch (error) {
      logger.error('Error in runE2eTests:', error);
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
      return { failed: true };
    }
  } catch (error) {
    logger.error('Error in runE2eTests:', error);
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
    return { failed: true };
  }
};

/**
 * Run both component and E2E tests
 */
async function runAllTests(
  testPath: string | undefined,
  options: { port?: number; name?: string; skipBuild?: boolean }
) {
  // Run component tests first
  const projectInfo = getProjectType(testPath);
  if (!options.skipBuild) {
    const componentResult = await runComponentTests(testPath, options, projectInfo);
    if (componentResult.failed) {
      logger.error('Component tests failed. Continuing to e2e tests...');
    }
  }

  // Run e2e tests
  const e2eResult = await runE2eTests(testPath, options, projectInfo);
  if (e2eResult.failed) {
    logger.error('E2E tests failed.');
    process.exit(1);
  }

  logger.success('All tests passed successfully!');
  process.exit(0);
}

// Create base test command with basic description only
export const test = new Command()
  .name('test')
  .description('Run tests for the current project or a specified plugin')
  .argument('[path]', 'Optional path to the project or plugin to test')
  .addOption(
    new Option('-t, --type <type>', 'the type of test to run')
      .choices(['component', 'e2e', 'all'])
      .default('all')
  )
  .option('-p, --port <port>', 'the port to run e2e tests on', validatePort)
  .option('--name <name>', 'filter tests by name')
  .option('--skip-build', 'skip the build step before running tests')
  .hook('preAction', (thisCommand) => {
    // Note: this hook is not triggered for subcommand actions
  })
  .action(async (testPath, options) => {
    logger.info('Starting all tests...');
    logger.info('Command options:');
    try {
      // Pass the testPath to runAllTests
      await runAllTests(testPath, options);
    } catch (error) {
      handleError(error);
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

async function installPluginDependencies(projectInfo: DirectoryInfo) {
  if (projectInfo.type !== 'elizaos-plugin') {
    return;
  }
  const project = await loadProject(process.cwd());
  if (project.isPlugin && project.pluginModule?.dependencies?.length > 0) {
    const pluginsDir = path.join(process.cwd(), '.eliza', 'plugins');
    if (!fs.existsSync(pluginsDir)) {
      await fs.promises.mkdir(pluginsDir, { recursive: true });
    }
    const packageJsonPath = path.join(pluginsDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      const packageJsonContent = {
        name: 'test-plugin-dependencies',
        version: '1.0.0',
        description: 'A temporary package for installing test plugin dependencies',
        dependencies: {},
      };
      await fs.promises.writeFile(packageJsonPath, JSON.stringify(packageJsonContent, null, 2));
    }

    for (const dependency of project.pluginModule.dependencies) {
      await installPlugin(dependency, pluginsDir);
      const dependencyPath = path.join(pluginsDir, 'node_modules', dependency);
      if (fs.existsSync(dependencyPath)) {
        try {
          const bunPath = await which('bun');
          await new Promise<void>((resolve, reject) => {
            const child = spawn(bunPath, ['install'], {
              cwd: dependencyPath,
              stdio: 'inherit',
              env: process.env,
            });
            child.on('close', (code) =>
              code === 0 ? resolve() : reject(`bun install failed with code ${code}`)
            );
            child.on('error', reject);
          });
        } catch (error) {
          logger.warn(
            `[Test Command] Failed to install devDependencies for ${dependency}: ${error}`
          );
        }
      }
    }
  }
}
