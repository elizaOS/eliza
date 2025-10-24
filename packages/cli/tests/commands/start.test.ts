import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { TEST_TIMEOUTS } from '../test-timeouts';
import {
  killProcessOnPort,
  safeChangeDirectory,
  TestProcessManager,
  waitForServerReady,
  cloneAndSetupPlugin,
} from './test-utils';
import { bunExecSimple } from '../../src/utils/bun-exec';

describe('ElizaOS Start Commands', () => {
  let testTmpDir: string;
  let elizaosPath: string;
  let originalCwd: string;
  let testServerPort: number;
  let processManager: TestProcessManager;
  let originalElizaTestMode: string | undefined;

  // Pick an ephemeral free port bound to 127.0.0.1 to avoid TIME_WAIT conflicts on Windows CI
  const getFreePort = async (): Promise<number> => {
    const net = await import('node:net');
    return await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(port));
      });
    });
  };

  beforeEach(async () => {
    // Store original working directory
    originalCwd = process.cwd();

    // Store original ELIZA_TEST_MODE
    originalElizaTestMode = process.env.ELIZA_TEST_MODE;

    // Initialize process manager
    processManager = new TestProcessManager();

    // ---- Ensure a free port (avoid hardcoding 3000 due to Windows TIME_WAIT)
    testServerPort = await getFreePort();
    await killProcessOnPort(testServerPort);
    await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));

    // Create temporary directory but don't change to it (keep monorepo context)
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-start-'));

    // Setup CLI path
    const scriptDir = join(__dirname, '..');
    elizaosPath = join(scriptDir, '../dist/index.js');

    // Make PORT + model envs explicit.
    process.env.LOCAL_SMALL_MODEL = 'DeepHermes-3-Llama-3-3B-Preview-q4.gguf';
    process.env.LOCAL_MEDIUM_MODEL = process.env.LOCAL_SMALL_MODEL;
    process.env.TEST_SERVER_PORT = testServerPort.toString();

    // Set test environment flags to skip local CLI delegation
    process.env.NODE_ENV = 'test';
    process.env.ELIZA_TEST_MODE = 'true';
    process.env.BUN_TEST = 'true';

    // Ensure these flags are available for all spawned processes
    process.env.ELIZA_CLI_TEST_MODE = 'true';
  });

  afterEach(async () => {
    // Clean up all processes
    await processManager.cleanup();

    // Clean up environment variables
    delete process.env.LOCAL_SMALL_MODEL;
    delete process.env.LOCAL_MEDIUM_MODEL;
    delete process.env.TEST_SERVER_PORT;
    delete process.env.NODE_ENV;
    delete process.env.ELIZA_TEST_MODE;
    delete process.env.BUN_TEST;
    delete process.env.ELIZA_CLI_TEST_MODE;

    // Restore original ELIZA_TEST_MODE
    if (originalElizaTestMode !== undefined) {
      process.env.ELIZA_TEST_MODE = originalElizaTestMode;
    } else {
      delete process.env.ELIZA_TEST_MODE;
    }

    // Restore original working directory
    safeChangeDirectory(originalCwd);

    if (testTmpDir && testTmpDir.includes('eliza-test-start-')) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  // Helper function to start server and wait for it to be ready
  const startServerAndWait = async (
    args: string,
    maxWaitTime: number = TEST_TIMEOUTS.SERVER_STARTUP
  ): Promise<any> => {
    await mkdir(join(testTmpDir, 'elizadb'), { recursive: true });

    const serverProcess = processManager.spawn(
      'bun',
      [join(__dirname, '..', '../dist/index.js'), 'start', ...args.split(' ')],
      {
        env: {
          ...process.env,
          LOG_LEVEL: 'info', // Reduce log verbosity in CI to prevent memory issues
          PGLITE_DATA_DIR: join(testTmpDir, 'elizadb'),
          SERVER_PORT: testServerPort.toString(),
          NODE_ENV: 'test',
          ELIZA_TEST_MODE: 'true',
          BUN_TEST: 'true',
          ELIZA_CLI_TEST_MODE: 'true',
          // Memory management for CI environments
          NODE_OPTIONS: '--max-old-space-size=2048', // Limit memory to 2GB
        },
        cwd: originalCwd, // Use monorepo root as working directory
        allowOutput: true, // Allow capturing output for debugging
      }
    );

    // Add error handling to capture server startup failures
    serverProcess.exited.then(() => {
      if (serverProcess.exitCode !== 0) {
        console.error(`Server process exited with code ${serverProcess.exitCode}`);
      }
    });

    // Wait for server to be ready
    await waitForServerReady(testServerPort, maxWaitTime);

    // Check if process is still running after startup
    if (serverProcess.killed || serverProcess.exitCode !== null) {
      throw new Error('Server process died during startup');
    }

    return serverProcess;
  };

  // Basic agent check
  it('start command shows help', async () => {
    const { stdout: result } = await bunExecSimple('bun', [elizaosPath, 'start', '--help'], {
      timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        ELIZA_TEST_MODE: 'true',
        BUN_TEST: 'true',
        ELIZA_CLI_TEST_MODE: 'true',
      },
    });
    expect(result).toContain('Usage: elizaos start');
    expect(result).toContain('--character');
    expect(result).toContain('--port');
  });

  it(
    'start and list shows Ada agent running',
    async () => {
      const charactersDir = join(__dirname, '../test-characters');
      const adaPath = join(charactersDir, 'ada.json');

      // Verify character file exists
      const fs = await import('node:fs');
      if (!fs.existsSync(adaPath)) {
        throw new Error(`Character file not found at: ${adaPath}`);
      }

      // Start a temporary server with Ada character
      const serverProcess = await startServerAndWait(`-p ${testServerPort} --character ${adaPath}`);

      try {
        // Wait longer for agent to fully register - CI environments may be slower
        await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.LONG_WAIT));

        // Retry logic for CI environments where agent registration might be delayed
        // GitHub Actions and other CI runners may have slower process startup times
        let result = '';
        let lastError: Error | null = null;
        const maxRetries = 5;

        for (let i = 0; i < maxRetries; i++) {
          try {
            // Check if server process is still running before making API calls
            if (serverProcess.exitCode !== null) {
              throw new Error(`Server process has exited with code ${serverProcess.exitCode}`);
            }

            // Quick health check before making API calls
            try {
              const response = await fetch(`http://localhost:${testServerPort}/health`);
              if (!response.ok) {
                throw new Error(`Server health check failed with status ${response.status}`);
              }
            } catch (fetchError) {
              const errorMsg =
                fetchError instanceof Error ? fetchError.message : String(fetchError);
              throw new Error(`Server is not responsive: ${errorMsg}`);
            }

            const { stdout } = await bunExecSimple(
              'bun',
              [elizaosPath, 'agent', 'list', '--remote-url', `http://localhost:${testServerPort}`],
              {
                timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
                env: {
                  ...process.env,
                  NODE_ENV: 'test',
                  ELIZA_TEST_MODE: 'true',
                  BUN_TEST: 'true',
                  ELIZA_CLI_TEST_MODE: 'true',
                },
              }
            );
            result = stdout;

            // If we get a result, check if it contains Ada
            if (result && result.toLowerCase().includes('ada')) {
              break;
            }

            // If we don't have Ada but no error, wait and retry
            if (i < maxRetries - 1) {
              await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));
            }
          } catch (error: any) {
            lastError = error;

            // Log detailed error information for debugging CI issues
            console.error(`[DEBUG] Attempt ${i + 1}/${maxRetries} failed:`, {
              errorMessage: error.message,
              serverExitCode: serverProcess.exitCode,
              serverKilled: serverProcess.killed,
              errorStack: error.stack?.split('\n')[0], // First line only
            });

            // If command failed and we have retries left, wait and retry
            if (i < maxRetries - 1) {
              // Check if server is still alive before retrying
              if (serverProcess.exitCode !== null) {
                // Server has died, no point in retrying
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.MEDIUM_WAIT));
            }
          }
        }

        // If we never got a successful result with Ada, throw the last error
        if (!result || !result.toLowerCase().includes('ada')) {
          if (lastError) {
            throw lastError;
          }
          throw new Error(
            `Agent list did not contain 'Ada' after ${maxRetries} retries. Output: ${result}`
          );
        }

        expect(result.toLowerCase()).toContain('ada');
      } finally {
        // Clean up server with proper graceful shutdown
        if (serverProcess.exitCode === null) {
          // Server is still running, shut it down gracefully
          serverProcess.kill('SIGTERM');

          // Wait for graceful shutdown
          try {
            await Promise.race([
              serverProcess.exited,
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Graceful shutdown timeout')), 5000)
              ),
            ]);
          } catch {
            // Force kill if graceful shutdown fails
            serverProcess.kill('SIGKILL');
          }
        }

        // Additional cleanup wait
        await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  // Custom port flag (-p)
  it(
    'custom port spin-up works',
    async () => {
      const newPort = 3456;
      const charactersDir = join(__dirname, '../test-characters');
      const adaPath = join(charactersDir, 'ada.json');

      await mkdir(join(testTmpDir, 'elizadb2'), { recursive: true });

      const serverProcess = processManager.spawn(
        'bun',
        [
          join(__dirname, '..', '../dist/index.js'),
          'start',
          '-p',
          newPort.toString(),
          '--character',
          adaPath,
        ],
        {
          env: {
            ...process.env,
            LOG_LEVEL: 'debug',
            PGLITE_DATA_DIR: join(testTmpDir, 'elizadb2'),
            NODE_ENV: 'test',
            ELIZA_TEST_MODE: 'true',
            BUN_TEST: 'true',
            ELIZA_CLI_TEST_MODE: 'true',
          },
          cwd: originalCwd, // Use monorepo root as working directory
          allowOutput: true,
        }
      );

      try {
        // Wait for server to be ready
        await waitForServerReady(newPort);

        // Verify server is accessible
        const response = await fetch(`http://localhost:${newPort}/api/agents`);
        expect(response.ok).toBe(true);
      } finally {
        serverProcess.kill();
        await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  // Multiple character input formats
  it('multiple character formats parse', async () => {
    const charactersDir = join(__dirname, '../test-characters');
    const adaPath = join(charactersDir, 'ada.json');

    const formats = [',', ' '];

    for (const fmt of formats) {
      const { stdout: result } = await bunExecSimple(
        'bun',
        [elizaosPath, 'start', '--character', `${adaPath}${fmt}${adaPath}`, '--help'],
        {
          timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            ELIZA_TEST_MODE: 'true',
            BUN_TEST: 'true',
            ELIZA_CLI_TEST_MODE: 'true',
          },
        }
      );
      expect(result).toContain('start');
    }
  });

  // Mixed valid/invalid files should not crash CLI when running with --help (dry)
  it('graceful acceptance of invalid character file list (dry)', async () => {
    const charactersDir = join(__dirname, '../test-characters');
    const adaPath = join(charactersDir, 'ada.json');

    const { stdout: result } = await bunExecSimple(
      'bun',
      [elizaosPath, 'start', '--character', `${adaPath},does-not-exist.json`, '--help'],
      {
        timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          ELIZA_TEST_MODE: 'true',
          BUN_TEST: 'true',
          ELIZA_CLI_TEST_MODE: 'true',
        },
      }
    );
    expect(result).toContain('start');
  });

  // --build flag accepted
  it('build option flag accepted', async () => {
    const { stdout: result } = await bunExecSimple(
      'bun',
      [elizaosPath, 'start', '--build', '--help'],
      {
        timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          ELIZA_TEST_MODE: 'true',
          BUN_TEST: 'true',
          ELIZA_CLI_TEST_MODE: 'true',
        },
      }
    );
    expect(result).toContain('start');
  });

  // --configure flag triggers reconfiguration message in log
  it(
    'configure option runs',
    async () => {
      const charactersDir = join(__dirname, '../test-characters');
      const adaPath = join(charactersDir, 'ada.json');

      await mkdir(join(testTmpDir, 'elizadb3'), { recursive: true });

      const serverProcess = processManager.spawn(
        'bun',
        [join(__dirname, '..', '../dist/index.js'), 'start', '--configure', '--character', adaPath],
        {
          env: {
            ...process.env,
            LOG_LEVEL: 'debug',
            PGLITE_DATA_DIR: join(testTmpDir, 'elizadb3'),
            NODE_ENV: 'test',
            ELIZA_TEST_MODE: 'true',
            BUN_TEST: 'true',
            ELIZA_CLI_TEST_MODE: 'true',
          },
          cwd: originalCwd, // Use monorepo root as working directory
          allowOutput: true,
        }
      );

      try {
        // Wait for configuration to start
        await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.MEDIUM_WAIT));

        // Check if process started (configure option was accepted)
        expect(serverProcess.pid).toBeDefined();
      } finally {
        serverProcess.kill();
        await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  // Basic server startup test without advanced features that require models
  it(
    'server starts and responds to health check',
    async () => {
      const charactersDir = join(__dirname, '../test-characters');
      const adaPath = join(charactersDir, 'ada.json');

      // Start server
      const serverProcess = await startServerAndWait(`-p ${testServerPort} --character ${adaPath}`);

      try {
        // Wait for server to be fully ready
        await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.MEDIUM_WAIT));

        // Health check
        const response = await fetch(`http://localhost:${testServerPort}/api/agents`);
        expect(response.ok).toBe(true);
      } finally {
        serverProcess.kill();
        await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  // Note: Auto-build functionality tests have been removed as they relied on mocking,
  // which is inappropriate for e2e tests. These tests should be implemented as unit tests
  // in a separate test file if the build behavior needs to be tested.

  // Test plugin loading in plugin directory
  it(
    'start command loads plugin when run in plugin directory',
    async () => {
      // Clone and setup the plugin
      const { pluginDir, cleanup } = await cloneAndSetupPlugin(
        'https://github.com/elizaOS-plugins/plugin-openai.git',
        '1.x'
      );

      try {
        // Create a test database directory
        const pluginDbDir = join(testTmpDir, 'plugindb');
        await mkdir(pluginDbDir, { recursive: true });

        console.log('[PLUGIN TEST] Starting server in plugin directory...');
        // Start server in plugin directory
        const serverProcess = processManager.spawn(
          'bun',
          [join(__dirname, '..', '../dist/index.js'), 'start', '-p', testServerPort.toString()],
          {
            env: {
              ...process.env,
              LOG_LEVEL: 'info',
              PGLITE_DATA_DIR: pluginDbDir,
              SERVER_PORT: testServerPort.toString(),
              NODE_ENV: 'test',
              ELIZA_TEST_MODE: 'true',
              BUN_TEST: 'true',
              ELIZA_CLI_TEST_MODE: 'true',
              NODE_OPTIONS: '--max-old-space-size=2048',
            },
            cwd: pluginDir,
            allowOutput: true,
          }
        );

        try {
          console.log('[PLUGIN TEST] Waiting for server to become ready...');
          // Wait for server to be ready with extended timeout for CI
          await waitForServerReady(testServerPort, TEST_TIMEOUTS.SERVER_STARTUP * 2);

          console.log('[PLUGIN TEST] Server ready, waiting for plugin initialization...');
          // Wait a bit more for plugin initialization
          await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.LONG_WAIT));

          // Check if process is still running
          if (serverProcess.exitCode !== null) {
            throw new Error(`Server process exited with code ${serverProcess.exitCode}`);
          }

          // Verify server is running
          const healthResponse = await fetch(`http://localhost:${testServerPort}/health`);
          expect(healthResponse.ok).toBe(true);

          // Get agents to verify plugin was loaded
          const agentsResponse = await fetch(`http://localhost:${testServerPort}/api/agents`);
          expect(agentsResponse.ok).toBe(true);

          const agentsData = await agentsResponse.json();
          console.log('[PLUGIN TEST] Full response:', JSON.stringify(agentsData, null, 2));

          // Handle nested response structure: { success: true, data: { agents: [...] } }
          const agents = agentsData.data?.agents || agentsData.agents || agentsData;
          console.log('[PLUGIN TEST] Agents array:', JSON.stringify(agents, null, 2));

          // Verify that an agent was created
          expect(agents).toBeDefined();
          expect(Array.isArray(agents)).toBe(true);
          expect(agents.length).toBeGreaterThan(0);

          // Get the first agent and check its details including plugins
          const firstAgent = agents[0];
          console.log('[PLUGIN TEST] First agent ID:', firstAgent.id);

          // Fetch detailed agent info to check plugins
          const agentDetailsResponse = await fetch(
            `http://localhost:${testServerPort}/api/agents/${firstAgent.id}`
          );
          expect(agentDetailsResponse.ok).toBe(true);

          const agentDetailsData = await agentDetailsResponse.json();
          console.log(
            '[PLUGIN TEST] Agent details response:',
            JSON.stringify(agentDetailsData, null, 2)
          );

          // Handle nested response structure
          const agentDetails = agentDetailsData.data || agentDetailsData;

          // Verify the plugin was loaded
          expect(agentDetails.plugins).toBeDefined();
          expect(Array.isArray(agentDetails.plugins)).toBe(true);

          // Check if plugin-openai is in the plugins list
          const hasOpenAIPlugin = agentDetails.plugins.some(
            (p: string) => p.includes('openai') || p.includes('plugin-openai')
          );
          expect(hasOpenAIPlugin).toBe(true);

          console.log('[PLUGIN TEST] Test passed - plugin-openai loaded successfully');
        } finally {
          // Cleanup server
          if (serverProcess.exitCode === null) {
            serverProcess.kill('SIGTERM');
            try {
              await Promise.race([
                serverProcess.exited,
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Graceful shutdown timeout')), 5000)
                ),
              ]);
            } catch {
              serverProcess.kill('SIGKILL');
            }
          }
          await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));
        }
      } finally {
        // Cleanup cloned plugin directory
        await cleanup();
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST * 4 // Quadruple timeout for git clone, build, and server startup
  );
});
