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
import {
  logger,
  type IAgentRuntime,
  type ProjectAgent,
  type Plugin,
  AgentRuntime,
} from '@elizaos/core';
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
import { installPlugin, loadPluginModule } from '@/src/utils';
import { getCliInstallTag } from '@/src/utils';
import { detectPluginContext, provideLocalPluginGuidance } from '@/src/utils/plugin-context';
import which from 'which';
const execAsync = promisify(exec);

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

function isValidPluginShape(obj: any): obj is Plugin {
  if (!obj || typeof obj !== 'object' || !obj.name) {
    return false;
  }
  // Check for the presence of at least one key functional property
  return !!(
    obj.init ||
    obj.services ||
    obj.providers ||
    obj.actions ||
    obj.memoryManagers ||
    obj.componentTypes ||
    obj.evaluators ||
    obj.adapter ||
    obj.models ||
    obj.events ||
    obj.routes ||
    obj.tests ||
    obj.config ||
    obj.description // description is also mandatory technically
  );
}

async function loadAndPreparePlugin(pluginName: string): Promise<Plugin | null> {
  const version = getCliInstallTag();
  let pluginModule: any;

  // Check if this is a local development scenario BEFORE attempting any loading
  const context = detectPluginContext(pluginName);

  if (context.isLocalDevelopment) {
    // For local development, we should never try to install - just load directly
    try {
      pluginModule = await loadPluginModule(pluginName);
      if (!pluginModule) {
        logger.error(`Failed to load local plugin ${pluginName}.`);
        provideLocalPluginGuidance(pluginName, context);
        return null;
      }
    } catch (error) {
      logger.error(`Error loading local plugin ${pluginName}: ${error}`);
      provideLocalPluginGuidance(pluginName, context);
      return null;
    }
  } else {
    // External plugin - use existing logic
    try {
      // Use the centralized loader first
      pluginModule = await loadPluginModule(pluginName);

      if (!pluginModule) {
        // If loading failed, try installing and then loading again
        try {
          await installPlugin(pluginName, process.cwd(), version);
          // Try loading again after installation using the centralized loader
          pluginModule = await loadPluginModule(pluginName);
        } catch (installError) {
          logger.error(`Failed to install plugin ${pluginName}: ${installError}`);
          return null; // Installation failed
        }

        if (!pluginModule) {
          logger.error(`Failed to load plugin ${pluginName} even after installation.`);
          return null; // Loading failed post-installation
        }
      }
    } catch (error) {
      // Catch any unexpected error during the combined load/install/load process
      logger.error(`An unexpected error occurred while processing plugin ${pluginName}: ${error}`);
      return null;
    }
  }

  if (!pluginModule) {
    logger.error(`Failed to process plugin ${pluginName} (module is null/undefined unexpectedly)`);
    return null;
  }

  // Construct the expected camelCase export name (e.g., @elizaos/plugin-foo-bar -> fooBarPlugin)
  const expectedFunctionName = `${pluginName
    .replace(/^@elizaos\/plugin-/, '') // Remove prefix
    .replace(/^@elizaos-plugins\//, '') // Remove alternative prefix
    .replace(/-./g, (match) => match[1].toUpperCase())}Plugin`; // Convert kebab-case to camelCase and add 'Plugin' suffix

  // 1. Prioritize the expected named export if it exists
  const expectedExport = pluginModule[expectedFunctionName];
  if (isValidPluginShape(expectedExport)) {
    return expectedExport as Plugin;
  }

  // 2. Check the default export if the named one wasn't found or valid
  const defaultExport = pluginModule.default;
  if (isValidPluginShape(defaultExport)) {
    if (expectedExport !== defaultExport) {
      return defaultExport as Plugin;
    }
  }

  // 3. If neither primary method worked, search all exports aggressively
  for (const key of Object.keys(pluginModule)) {
    if (key === expectedFunctionName || key === 'default') {
      continue;
    }

    const potentialPlugin = pluginModule[key];
    if (isValidPluginShape(potentialPlugin)) {
      return potentialPlugin as Plugin;
    }
  }

  logger.warn(
    `Could not find a valid plugin export in ${pluginName}. Checked exports: ${expectedFunctionName} (if exists), default (if exists), and others. Available exports: ${Object.keys(pluginModule).join(', ')}`
  );
  return null;
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

    logger.info('Executing: bun', args.join(' '));

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
      logger.info('Component tests completed');
      resolve({ failed: code !== 0 });
    });

    child.on('error', (error) => {
      logger.error('Error running component tests:', error);
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

    // Wait for database initialization
    logger.info('Waiting for database initialization...');

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
              logger.warn(
                `Database initialization attempt ${initializationAttempts}/${maxAttempts} failed:`,
                initError
              );

              // Check if we've reached the maximum attempts
              if (initializationAttempts >= maxAttempts) {
                if (await server.database?.getConnection()) {
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
        setTimeout(async () => {
          clearInterval(checkInterval);
          if (await server.database?.getConnection()) {
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
      try {
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
      } catch (loadError) {
        logger.error('Error loading project/plugin:', loadError);

        // For testing purposes, let's try to find the dist version of index.js
        const distIndexPath = path.join(process.cwd(), 'dist', 'index.js');
        if (fs.existsSync(distIndexPath)) {
          try {
            logger.info(`Attempting to load project from dist/index.js instead...`);
            const distModule = await import(pathToFileURL(distIndexPath).href);
            if (distModule && (distModule.default || distModule.character || distModule.plugin)) {
              logger.info(`Successfully loaded project from dist/index.js`);

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

              logger.info(`Created project with ${project.agents.length} agents`);
            } else {
              throw new Error(`dist/index.js exists but doesn't export expected properties`);
            }
          } catch (distError) {
            logger.error(`Failed to load from dist/index.js:`, distError);
            throw loadError; // Rethrow the original error
          }
        } else {
          // Throw the original loadError to be caught by the outer try-catch,
          // which will then ensure server.stop() is called.
          logger.error('Tests cannot run without a valid project or plugin.');
          if (loadError instanceof Error) {
            if (
              loadError.message.includes('Could not find project entry point') ||
              loadError.message.includes('No main field')
            ) {
              logger.error(
                'No Eliza project or plugin found in current directory, or package.json is missing a "main" field.'
              );
              logger.error(
                'Tests can only run in a valid Eliza project or plugin directory with a valid package.json.'
              );
            }
          }
          throw loadError; // Propagate error
        }
      }

      logger.info('Starting server...');
      try {
        // Check if the port is available first
        if (!(await checkPortAvailable(serverPort))) {
          logger.error(`Port ${serverPort} is already in use. Choose another with --port.`);
          throw new Error(`Port ${serverPort} is already in use`);
        }

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
            const pluginUnderTest = project.pluginModule;
            if (!pluginUnderTest) {
              throw new Error('Plugin module could not be loaded for testing.');
            }
            const defaultElizaCharacter = getElizaCharacter();

            // 1. Consolidate all plugin names: dependencies AND default plugins
            const requiredPluginNames = new Set<string>([
              ...(pluginUnderTest.dependencies || []),
              ...(defaultElizaCharacter.plugins || []),
            ]);

            // 2. Load all required plugins into objects
            const dependencyPlugins: Plugin[] = [];
            for (const name of requiredPluginNames) {
              const loadedPlugin = await loadAndPreparePlugin(name);
              if (loadedPlugin) {
                dependencyPlugins.push(loadedPlugin);
              } else {
                logger.warn(`Failed to load dependency plugin for test: ${name}`);
              }
            }

            // 3. Manually create the runtime and register plugins in order
            const runtime = new AgentRuntime({
              character: defaultElizaCharacter,
              // We register manually to control the order precisely
              settings: {
                // Pass the server's db config directly to the runtime
                dataDir: elizaDbDir,
                postgresUrl,
              },
            });

            // 3a. Register all dependencies FIRST
            for (const depPlugin of dependencyPlugins) {
              await runtime.registerPlugin(depPlugin);
            }
            logger.info(`Registered ${dependencyPlugins.length} dependency and default plugins.`);

            // 3b. Register the plugin under test SECOND
            await runtime.registerPlugin(pluginUnderTest);
            logger.info(`Registered plugin under test: ${pluginUnderTest.name}`);

            // 3c. Initialize the runtime LAST
            await runtime.initialize();

            server.registerAgent(runtime);
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
async function runAllTests(options: { port?: number; name?: string; skipBuild?: boolean }) {
  // Run component tests first
  const projectInfo = getProjectType();
  if (!options.skipBuild) {
    await installPluginDependencies(projectInfo);
  }
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

    logger.info('Starting component tests...');
    logger.info('Command options:', options);

    try {
      const projectInfo = getProjectType();
      const result = await runComponentTests(options, projectInfo);
      process.exit(result.failed ? 1 : 0);
    } catch (error) {
      logger.error('Error running component tests:', error);
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

    logger.info('Starting e2e tests...');
    logger.info('Command options:', options);

    try {
      const projectInfo = getProjectType();
      const result = await runE2eTests(options, projectInfo);
      process.exit(result.failed ? 1 : 0);
    } catch (error) {
      logger.error('Error running e2e tests:', error);
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

    logger.info('Starting all tests...');
    logger.info('Command options:', options);

    try {
      const projectInfo = getProjectType();
      const result = await runAllTests(options);
      process.exit(result.failed ? 1 : 0);
    } catch (error) {
      logger.error('Error running tests:', error);
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
