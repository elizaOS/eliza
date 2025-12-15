import { loadProject, type Project } from '@/src/project';
import { buildProject, TestRunner, UserEnvironment } from '@/src/utils';
import { type DirectoryInfo } from '@/src/utils/directory-detection';
import { logger, type IAgentRuntime, type ProjectAgent } from '@elizaos/core';
import { getDefaultCharacter } from '@/src/characters/eliza';
import { AgentServer } from '@elizaos/server';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import path from 'node:path';
import { E2ETestOptions, TestResult } from '../types';
import { processFilterName } from '../utils/project-utils';

/**
 * Function that runs the end-to-end tests.
 *
 * Sets up a complete test environment with database, server, and agents, then executes e2e tests using the TestRunner framework.
 */
export async function runE2eTests(
  testPath: string | undefined,
  options: E2ETestOptions,
  projectInfo: DirectoryInfo
): Promise<TestResult> {
  // Build the project or plugin first unless skip-build is specified
  if (!options.skipBuild) {
    try {
      const cwd = process.cwd();
      const isPlugin = projectInfo.type === 'elizaos-plugin';
      logger.info({ src: 'cli', command: 'test-e2e', isPlugin }, 'Building project');
      await buildProject(cwd, isPlugin);
      logger.info({ src: 'cli', command: 'test-e2e' }, 'Build completed successfully');
    } catch (buildError) {
      logger.error(
        {
          src: 'cli',
          command: 'test-e2e',
          error: buildError instanceof Error ? buildError.message : String(buildError),
        },
        'Build error'
      );
      logger.warn(
        { src: 'cli', command: 'test-e2e' },
        'Attempting to continue with tests despite build error'
      );
    }
  }

  let server: AgentServer | undefined; // Will be AgentServer instance from module loader
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
      logger.info(
        { src: 'cli', command: 'test-e2e', envFilePath },
        'Loading environment variables'
      );
      dotenv.config({ path: envFilePath });
      logger.info({ src: 'cli', command: 'test-e2e' }, 'Environment variables loaded');
    } else {
      logger.warn({ src: 'cli', command: 'test-e2e', envFilePath }, 'Environment file not found');
    }

    // Database directory has been set in environment variables above
    // Look for PostgreSQL URL in environment variables
    const postgresUrl = process.env.POSTGRES_URL;
    logger.info(
      { src: 'cli', command: 'test-e2e', hasPostgresUrl: !!postgresUrl },
      'PostgreSQL URL check'
    );

    // Create server instance
    logger.info({ src: 'cli', command: 'test-e2e' }, 'Creating server instance');
    server = new AgentServer();
    logger.info({ src: 'cli', command: 'test-e2e' }, 'Server instance created');

    // Server will initialize automatically when start() is called
    logger.info({ src: 'cli', command: 'test-e2e' }, 'Server instance ready');

    let project: Project | undefined;
    try {
      logger.info({ src: 'cli', command: 'test-e2e' }, 'Attempting to load project or plugin');
      // Resolve path - use monorepo root if available, otherwise use cwd
      const monorepoRoot = UserEnvironment.getInstance().findMonorepoRoot(process.cwd());
      const baseDir = monorepoRoot ?? process.cwd();
      const targetPath = testPath ? path.resolve(baseDir, testPath) : process.cwd();

      project = await loadProject(targetPath);

      // For plugins, it's OK to have no agents defined (will use default Eliza)
      // For projects, we need at least one agent
      if (!project) {
        throw new Error('Failed to load project');
      }

      if (!project.isPlugin && (!project.agents || project.agents.length === 0)) {
        logger.warn(
          { src: 'cli', command: 'test-e2e' },
          'No agents found in project configuration; falling back to default Eliza character for tests'
        );
      }

      logger.info(
        { src: 'cli', command: 'test-e2e', agentCount: project.agents?.length || 0 },
        'Found agents'
      );

      // Note: AgentManager was removed, using AgentServer's startAgents directly
      logger.info({ src: 'cli', command: 'test-e2e' }, 'Starting server');
      try {
        // Server will auto-discover available port (don't pass port for auto-discovery)
        // If options.port is provided, pass it (will fail if not available - strict mode)
        await server.start(options.port ? { port: options.port } : undefined);
        logger.info({ src: 'cli', command: 'test-e2e' }, 'Server started successfully');
      } catch (error) {
        logger.error(
          {
            src: 'cli',
            command: 'test-e2e',
            error: error instanceof Error ? error.message : String(error),
          },
          'Error starting server'
        );
        if (error instanceof Error) {
          logger.error(
            { src: 'cli', command: 'test-e2e', message: error.message, stack: error.stack },
            'Error details'
          );
        }
        throw error;
      }

      try {
        // Start each agent in sequence
        logger.info(
          {
            src: 'cli',
            command: 'test-e2e',
            agentCount: project.agents.length,
            isPlugin: project.isPlugin,
          },
          'Found agents in project'
        );

        // When testing a plugin, import and use the default Eliza character
        // to ensure consistency with the start command
        // For projects, only use default agent if no agents are defined
        if (project.isPlugin || (project.agents?.length || 0) === 0) {
          // Set environment variable to signal this is a direct plugin test
          // The TestRunner uses this to identify direct plugin tests
          process.env.ELIZA_TESTING_PLUGIN = 'true';

          logger.info(
            { src: 'cli', command: 'test-e2e' },
            'Using default Eliza character as test agent'
          );
          try {
            const pluginUnderTest = project.pluginModule;
            if (!pluginUnderTest) {
              throw new Error('Plugin module could not be loaded for testing.');
            }
            const defaultElizaCharacter = getDefaultCharacter();

            // Use AgentServer's startAgents method with the plugin under test
            // isTestMode: true ensures testDependencies are loaded
            const startedRuntimes = await server.startAgents(
              [
                {
                  character: defaultElizaCharacter,
                  plugins: [pluginUnderTest],
                },
              ],
              { isTestMode: true }
            );
            const runtime = startedRuntimes[0];

            runtimes.push(runtime);

            // Pass all loaded plugins to the projectAgent so TestRunner can identify
            // which one is the plugin under test vs dependencies
            projectAgents.push({
              character: defaultElizaCharacter,
              plugins: runtime.plugins, // Pass all plugins, not just the one under test
            });

            logger.info(
              { src: 'cli', command: 'test-e2e' },
              'Default test agent started successfully'
            );
          } catch (pluginError) {
            logger.error(
              {
                src: 'cli',
                command: 'test-e2e',
                error: pluginError instanceof Error ? pluginError.message : String(pluginError),
              },
              'Error starting plugin test agent'
            );
            throw pluginError;
          }
        } else {
          // For regular projects, start agents with delay between each (for E2E test stability)
          for (const agent of project.agents) {
            try {
              logger.debug(
                { src: 'cli', command: 'test-e2e', agentName: agent.character.name },
                'Starting agent'
              );

              // isTestMode: true ensures testDependencies are loaded for project tests
              // init function is now automatically called by Core
              const startedRuntimes = await server.startAgents(
                [
                  {
                    character: { ...agent.character },
                    plugins: agent.plugins || [],
                    init: agent.init,
                  },
                ],
                { isTestMode: true }
              );
              const runtime = startedRuntimes[0];

              runtimes.push(runtime);
              projectAgents.push(agent);

              // wait 1 second between agent starts for E2E test stability
              await new Promise((resolve) => setTimeout(resolve, 1000));
            } catch (agentError) {
              logger.error(
                {
                  src: 'cli',
                  command: 'test-e2e',
                  error: agentError instanceof Error ? agentError.message : String(agentError),
                  agentName: agent.character.name,
                },
                'Error starting agent'
              );
              if (agentError instanceof Error) {
                logger.error(
                  {
                    src: 'cli',
                    command: 'test-e2e',
                    message: agentError.message,
                    stack: agentError.stack,
                  },
                  'Error details'
                );
              }
              // Log the error but don't fail the entire test run
              logger.warn(
                { src: 'cli', command: 'test-e2e', agentName: agent.character.name },
                'Skipping agent due to startup error'
              );
            }
          }
        }

        if (runtimes.length === 0) {
          throw new Error('Failed to start any agents from project');
        }

        logger.debug(
          { src: 'cli', command: 'test-e2e', runtimeCount: runtimes.length },
          'Successfully started agents for testing'
        );

        // Run tests for each agent
        let totalFailed = 0;
        let anyTestsFound = false;
        for (let i = 0; i < runtimes.length; i++) {
          const runtime = runtimes[i];
          const projectAgent = projectAgents[i];

          if (project.isPlugin) {
            logger.debug(
              { src: 'cli', command: 'test-e2e', pluginName: project.pluginModule?.name },
              'Running tests for plugin'
            );
          } else {
            logger.debug(
              { src: 'cli', command: 'test-e2e', agentName: runtime.character.name },
              'Running tests for agent'
            );
          }

          // Pass the runtime directly without modification to avoid pino logger context issues
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
        // This aligns with standard testing tools behavior
        return { failed: anyTestsFound ? totalFailed > 0 : false };
      } catch (error) {
        logger.error(
          {
            src: 'cli',
            command: 'test-e2e',
            error: error instanceof Error ? error.message : String(error),
          },
          'Error in runE2eTests'
        );
        if (error instanceof Error) {
          logger.error(
            { src: 'cli', command: 'test-e2e', message: error.message, stack: error.stack },
            'Error details'
          );
        } else {
          logger.error(
            { src: 'cli', command: 'test-e2e', type: typeof error },
            'Unknown error type'
          );
          try {
            logger.error(
              { src: 'cli', command: 'test-e2e', stringified: JSON.stringify(error, null, 2) },
              'Stringified error'
            );
          } catch (e) {
            logger.error(
              {
                src: 'cli',
                command: 'test-e2e',
                error: e instanceof Error ? e.message : String(e),
              },
              'Could not stringify error'
            );
          }
        }
        return { failed: true };
      } finally {
        // Clean up the ELIZA_TESTING_PLUGIN environment variable
        if (process.env.ELIZA_TESTING_PLUGIN) {
          delete process.env.ELIZA_TESTING_PLUGIN;
        }

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
      logger.error(
        {
          src: 'cli',
          command: 'test-e2e',
          error: error instanceof Error ? error.message : String(error),
        },
        'Error loading project'
      );
      throw error;
    }
  } catch (error) {
    logger.error(
      {
        src: 'cli',
        command: 'test-e2e',
        error: error instanceof Error ? error.message : String(error),
      },
      'Error in runE2eTests'
    );
    return { failed: true };
  }
}
