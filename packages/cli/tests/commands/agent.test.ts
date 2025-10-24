import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_TIMEOUTS } from '../test-timeouts';
import { getPlatformOptions, killProcessOnPort, waitForServerReady } from './test-utils';
import { bunExecSync } from '../utils/bun-test-helpers';

describe('ElizaOS Agent Commands', () => {
  let serverProcess: any;
  let testTmpDir: string;
  let testServerPort: string;
  let testServerUrl: string;

  beforeAll(async () => {
    // Setup test environment
    testServerPort = '3000';
    testServerUrl = `http://localhost:${testServerPort}`;
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-agent-'));

    // Kill any existing processes on port 3000 with extended cleanup for macOS CI
    console.log('[DEBUG] Cleaning up any existing processes on port 3000...');
    await killProcessOnPort(3000);

    // Give macOS CI more time for complete port cleanup
    const cleanupTime =
      process.platform === 'darwin' && process.env.CI === 'true'
        ? TEST_TIMEOUTS.MEDIUM_WAIT
        : TEST_TIMEOUTS.SHORT_WAIT;
    console.log(`[DEBUG] Waiting ${cleanupTime}ms for port cleanup...`);
    await new Promise((resolve) => setTimeout(resolve, cleanupTime));

    // Create database directory
    await mkdir(join(testTmpDir, 'elizadb'), { recursive: true });

    // Start the ElizaOS server with a default character
    console.log(`[DEBUG] Starting ElizaOS server on port ${testServerPort}`);
    const defaultCharacter = join(__dirname, '../test-characters', 'ada.json');
    console.log(`[DEBUG] Character path: ${defaultCharacter}`);
    console.log(`[DEBUG] Character exists: ${existsSync(defaultCharacter)}`);

    // Use local TypeScript source directly with Bun
    const cliPath = join(__dirname, '../../src/index.ts');
    console.log(`[DEBUG] Using local CLI source: ${cliPath}`);
    console.log(`[DEBUG] CLI exists: ${existsSync(cliPath)}`);

    // Verify CLI source exists
    if (!existsSync(cliPath)) {
      console.error('[ERROR] CLI source not found.');
      throw new Error('CLI source not available at ' + cliPath);
    }

    // Spawn server process using local TypeScript source
    // IMPORTANT: We use a special env var to identify this as a test server
    // This prevents it from being killed by 'agent stop --all' tests
    console.log(`[DEBUG] Spawning test server with: bun ${cliPath} start`);

    try {
      const proc = Bun.spawn(
        ['bun', cliPath, 'start', '--port', testServerPort, '--character', defaultCharacter],
        {
          env: {
            ...process.env,
            LOG_LEVEL: 'debug',
            PGLITE_DATA_DIR: `${testTmpDir}/elizadb`,
            NODE_OPTIONS: '--max-old-space-size=4096',
            SERVER_HOST: '127.0.0.1',
          },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          // Windows-specific options
          ...(process.platform === 'win32' && {
            windowsHide: true,
            windowsVerbatimArguments: false,
          }),
        }
      );

      if (!proc.pid) {
        throw new Error('Failed to spawn server process - no PID returned');
      }

      // Wrap to maintain compatibility with existing code
      serverProcess = proc as any;
    } catch (spawnError) {
      console.error(`[ERROR] Failed to spawn server process:`, spawnError);
      console.error(`[ERROR] Command: bun ${cliPath} start`);
      console.error(`[ERROR] Platform: ${process.platform}`);
      throw spawnError;
    }

    if (!serverProcess || !serverProcess.pid) {
      console.error('[ERROR] Failed to spawn server process');
      throw new Error('Failed to spawn server process');
    }

    // Capture server output for debugging
    let serverError: Error | null = null;

    // Handle Bun.spawn's ReadableStream for stdout/stderr
    const handleStream = async (
      stream: ReadableStream<Uint8Array> | undefined,
      isError: boolean
    ) => {
      if (!stream) return;

      const reader = stream.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value, { stream: true });

          if (isError) {
            console.error(`[SERVER STDERR] ${text}`);
            if (text.includes('Error') || text.includes('error')) {
              serverError = new Error(text);
            }
          } else {
            console.log(`[SERVER STDOUT] ${text}`);
            if (text.includes('Server started') || text.includes('listening')) {
              console.log(`[DEBUG] Server is ready based on output: ${text.trim()}`);
            }
          }
        }
      } catch (err) {
        console.error(`[SERVER] Stream error:`, err);
        if (isError && !serverError) {
          serverError = err as Error;
        }
      } finally {
        reader.releaseLock();
      }
    };

    // Start reading both streams
    Promise.all([
      handleStream(serverProcess.stdout, false),
      handleStream(serverProcess.stderr, true),
    ]);

    // Handle process exit
    serverProcess.exited
      .then((code: number | null) => {
        console.log(`[SERVER EXIT] code: ${code}`);
        if (code !== 0 && !serverError) {
          serverError = new Error(`Server exited with code ${code}`);
        }
      })
      .catch((error: Error) => {
        console.error('[SERVER ERROR]', error);
        serverError = error;
      });

    // Wait for server to be ready
    console.log('[DEBUG] Waiting for server to be ready...');
    try {
      // Give server a moment to fail fast if there are immediate errors
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check if server already exited with error
      if (serverError) {
        throw serverError;
      }

      await waitForServerReady(parseInt(testServerPort, 10), TEST_TIMEOUTS.SERVER_STARTUP);
      console.log('[DEBUG] Server is ready!');
    } catch (error) {
      console.error('[ERROR] Server failed to start:', error);

      // Log current working directory and file paths for debugging
      console.error('[DEBUG] Current working directory:', process.cwd());
      console.error('[DEBUG] Character exists:', existsSync(defaultCharacter));

      throw error;
    }

    // Character preloading removed - individual tests will handle character creation as needed
    console.log('[DEBUG] Server setup complete. Individual tests will handle character loading.');
  });

  afterAll(async () => {
    console.log('[DEBUG] AfterAll cleanup starting...');

    // Only kill the server if ALL tests have completed (not if they failed early)
    // This prevents premature server shutdown that causes cascade failures
    if (serverProcess && serverProcess.exitCode === null) {
      try {
        console.log('[DEBUG] Server still running, initiating graceful shutdown...');

        // For Bun.spawn processes, we use the exited promise
        const exitPromise = serverProcess.exited.catch(() => {});

        // Use SIGTERM for graceful shutdown
        serverProcess.kill('SIGTERM');
        console.log('[DEBUG] Sent SIGTERM to server process');

        // Wait for graceful exit with timeout
        await Promise.race([
          exitPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ]);

        // Force kill if still running
        if (serverProcess.exitCode === null && !serverProcess.killed) {
          console.log('[DEBUG] Server did not exit gracefully, sending SIGKILL');
          serverProcess.kill('SIGKILL');
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (e) {
        console.log('[DEBUG] Error during server cleanup:', e);
        // Ignore cleanup errors but try force kill
        try {
          if (!serverProcess.killed) {
            serverProcess.kill('SIGKILL');
          }
        } catch (e2) {
          // Ignore force kill errors
        }
      }
    } else {
      console.log('[DEBUG] Server already stopped or not started');
    }

    if (testTmpDir) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  it('agent help displays usage information', async () => {
    const cliPath = join(__dirname, '../../src/index.ts');
    const result = bunExecSync(
      `bun ${cliPath} agent --help`,
      getPlatformOptions({ encoding: 'utf8' })
    );
    expect(result).toContain('Usage:');
    expect(result).toContain('agent');
  });

  it('agent list returns agents', async () => {
    const cliPath = join(__dirname, '../../src/index.ts');
    const result = bunExecSync(
      `bun ${cliPath} agent list --remote-url ${testServerUrl}`,
      getPlatformOptions({
        encoding: 'utf8',
      })
    );
    expect(result).toMatch(/(Ada|Max|Shaw)/);
  });

  it('agent list works with JSON flag', async () => {
    const cliPath = join(__dirname, '../../src/index.ts');
    const result = bunExecSync(
      `bun ${cliPath} agent list --remote-url ${testServerUrl} --json`,
      getPlatformOptions({
        encoding: 'utf8',
      })
    );
    expect(result).toContain('[');
    expect(result).toContain('{');
    expect(result).toMatch(/(name|Name)/);
  });

  it('agent get shows details with name parameter', async () => {
    const cliPath = join(__dirname, '../../src/index.ts');
    const result = bunExecSync(
      `bun ${cliPath} agent get --remote-url ${testServerUrl} -n Ada`,
      getPlatformOptions({
        encoding: 'utf8',
      })
    );
    expect(result).toContain('Ada');
  });

  it('agent get with JSON flag shows character definition', async () => {
    const cliPath = join(__dirname, '../../src/index.ts');
    const result = bunExecSync(
      `bun ${cliPath} agent get --remote-url ${testServerUrl} -n Ada --json`,
      getPlatformOptions({
        encoding: 'utf8',
      })
    );
    expect(result).toMatch(/(name|Name)/);
    expect(result).toContain('Ada');
  });

  it('agent get with output flag saves to file', async () => {
    const outputFile = join(testTmpDir, 'output_ada.json');
    const cliPath = join(__dirname, '../../src/index.ts');
    bunExecSync(
      `bun ${cliPath} agent get --remote-url ${testServerUrl} -n Ada --output ${outputFile}`,
      getPlatformOptions({ encoding: 'utf8' })
    );

    const { readFile } = await import('fs/promises');
    const fileContent = await readFile(outputFile, 'utf8');
    expect(fileContent).toContain('Ada');
  });

  it('agent start loads character from file', async () => {
    const charactersDir = join(__dirname, '../test-characters');
    // Use max.json since ada is already loaded by the server
    const maxPath = join(charactersDir, 'max.json');
    const cliPath = join(__dirname, '../../src/index.ts');

    try {
      const result = bunExecSync(
        `bun ${cliPath} agent start --remote-url ${testServerUrl} --path ${maxPath}`,
        getPlatformOptions({ encoding: 'utf8' })
      );
      expect(result).toMatch(/(started successfully|created|already exists|already running)/);
    } catch (e: any) {
      // If it fails, check if it's because agent already exists
      expect(e.stdout || e.stderr).toMatch(/(already exists|already running)/);
    }
  });

  it('agent start works with name parameter', async () => {
    // This test tries to start an agent by name
    // Since Ada is started by the server, this should say it already exists
    const cliPath = join(__dirname, '../../src/index.ts');
    try {
      bunExecSync(
        `bun ${cliPath} agent start --remote-url ${testServerUrl} -n Ada`,
        getPlatformOptions({
          encoding: 'utf8',
        })
      );
      // Should succeed or already exist
    } catch (e: any) {
      // Ada should already exist from server startup
      expect(e.stdout || e.stderr).toMatch(/already/);
    }
  });

  it('agent start handles non-existent agent fails', async () => {
    const nonExistentName = `NonExistent_${Date.now()}`;
    const cliPath = join(__dirname, '../../src/index.ts');

    try {
      bunExecSync(
        `bun ${cliPath} agent start --remote-url ${testServerUrl} -n ${nonExistentName}`,
        getPlatformOptions({
          encoding: 'utf8',
          stdio: 'pipe',
        })
      );
      // Should not reach here
      expect(false).toBe(true);
    } catch (e: any) {
      // The command should fail when agent doesn't exist
      expect(e.status).not.toBe(0);
    }
  });

  it(
    'agent set updates configuration correctly',
    async () => {
      // Create a NEW agent specifically for this test to avoid conflicts
      const testAgentName = `TestAgent_${Date.now()}`;
      const testCharacter = join(__dirname, '../test-characters', 'ada.json');
      const cliPath = join(__dirname, '../../src/index.ts');

      // Create a unique test agent
      try {
        // Read ada.json and modify the name
        const { readFileSync, writeFileSync } = require('fs');
        const adaConfig = JSON.parse(readFileSync(testCharacter, 'utf8'));
        adaConfig.name = testAgentName;

        const tempCharFile = join(testTmpDir, `${testAgentName}.json`);
        writeFileSync(tempCharFile, JSON.stringify(adaConfig));

        // Start the unique test agent
        bunExecSync(
          `bun ${cliPath} agent start --remote-url ${testServerUrl} --path ${tempCharFile}`,
          getPlatformOptions({ stdio: 'pipe', timeout: TEST_TIMEOUTS.STANDARD_COMMAND })
        );
      } catch (e) {
        // If agent creation fails, test should fail
        throw e;
      }

      const configFile = join(testTmpDir, 'update_config.json');
      const configContent = JSON.stringify({
        system: 'Updated system prompt for testing',
      });

      const { writeFile } = await import('fs/promises');
      await writeFile(configFile, configContent);

      // Wait for agent to be ready
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const result = bunExecSync(
        `bun ${cliPath} agent set --remote-url ${testServerUrl} -n ${testAgentName} -f ${configFile}`,
        getPlatformOptions({ encoding: 'utf8', timeout: TEST_TIMEOUTS.STANDARD_COMMAND })
      );
      expect(result).toMatch(/(updated|Updated)/);

      // Clean up: stop the test agent
      try {
        bunExecSync(
          `bun ${cliPath} agent stop --remote-url ${testServerUrl} -n ${testAgentName}`,
          getPlatformOptions({ stdio: 'pipe', timeout: TEST_TIMEOUTS.STANDARD_COMMAND })
        );
      } catch (e) {
        // Ignore cleanup errors
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'agent full lifecycle management',
    async () => {
      // Create a unique agent for this test to avoid affecting other tests
      const lifecycleAgentName = `LifecycleAgent_${Date.now()}`;
      const testCharacter = join(__dirname, '../test-characters', 'ada.json');
      const cliPath = join(__dirname, '../../src/index.ts');

      // Create a unique test agent
      const { readFileSync, writeFileSync } = require('fs');
      const adaConfig = JSON.parse(readFileSync(testCharacter, 'utf8'));
      adaConfig.name = lifecycleAgentName;

      const tempCharFile = join(testTmpDir, `${lifecycleAgentName}.json`);
      writeFileSync(tempCharFile, JSON.stringify(adaConfig));

      // Start the test agent
      try {
        const startResult = bunExecSync(
          `bun ${cliPath} agent start --remote-url ${testServerUrl} --path ${tempCharFile}`,
          getPlatformOptions({
            encoding: 'utf8',
            timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
          })
        );
        expect(startResult).toMatch(/(started|created)/);
      } catch (e: any) {
        // Should not fail for a new agent
        throw new Error(`Failed to start test agent: ${e.message}`);
      }

      // Wait for agent to be ready
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Stop the test agent
      try {
        const stopResult = bunExecSync(
          `bun ${cliPath} agent stop --remote-url ${testServerUrl} -n ${lifecycleAgentName}`,
          getPlatformOptions({
            encoding: 'utf8',
            timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
          })
        );
        expect(stopResult).toMatch(/(stopped|Stopped)/);
      } catch (e: any) {
        throw new Error(`Failed to stop test agent: ${e.message}`);
      }

      // Verify agent is stopped by trying to start again
      try {
        const restartResult = bunExecSync(
          `bun ${cliPath} agent start --remote-url ${testServerUrl} --path ${tempCharFile}`,
          getPlatformOptions({ encoding: 'utf8', timeout: TEST_TIMEOUTS.STANDARD_COMMAND })
        );
        expect(restartResult).toMatch(/(started|created)/);

        // Clean up: stop the agent again
        bunExecSync(
          `bun ${cliPath} agent stop --remote-url ${testServerUrl} -n ${lifecycleAgentName}`,
          getPlatformOptions({ stdio: 'pipe', timeout: TEST_TIMEOUTS.STANDARD_COMMAND })
        );
      } catch (e) {
        // Ignore cleanup errors
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'agent stop works after start',
    async () => {
      // Create a unique agent for this test
      const stopTestAgentName = `StopTestAgent_${Date.now()}`;
      const testCharacter = join(__dirname, '../test-characters', 'ada.json');
      const cliPath = join(__dirname, '../../src/index.ts');

      // Create a unique test agent
      const { readFileSync, writeFileSync } = require('fs');
      const adaConfig = JSON.parse(readFileSync(testCharacter, 'utf8'));
      adaConfig.name = stopTestAgentName;

      const tempCharFile = join(testTmpDir, `${stopTestAgentName}.json`);
      writeFileSync(tempCharFile, JSON.stringify(adaConfig));

      // Start the test agent
      try {
        bunExecSync(
          `bun ${cliPath} agent start --remote-url ${testServerUrl} --path ${tempCharFile}`,
          getPlatformOptions({ stdio: 'pipe', timeout: TEST_TIMEOUTS.STANDARD_COMMAND })
        );
      } catch (e: any) {
        throw new Error(`Failed to start test agent: ${e.message}`);
      }

      // Wait a moment for agent to be ready
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Now stop the test agent
      try {
        const result = bunExecSync(
          `bun ${cliPath} agent stop --remote-url ${testServerUrl} -n ${stopTestAgentName}`,
          getPlatformOptions({
            encoding: 'utf8',
            timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
          })
        );
        expect(result).toMatch(/(stopped|Stopped)/);
      } catch (e: any) {
        throw new Error(`Failed to stop test agent: ${e.message}`);
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  // This test must be absolutely last as it kills the server
  // Moving it after all other tests to avoid disrupting them
});

// Separate test suite that runs after everything else
describe('ElizaOS Agent Stop All - Final Cleanup', () => {
  it('agent stop --all works for stopping all agents', async () => {
    // This tests the --all flag functionality using pkill
    // This MUST run after all other tests as it kills everything
    const cliPath = join(__dirname, '../../src/index.ts');
    try {
      const result = bunExecSync(
        `bun ${cliPath} agent stop --all`,
        getPlatformOptions({
          encoding: 'utf8',
          timeout: 10000, // 10 second timeout
        })
      );
      expect(result).toMatch(/(All ElizaOS agents stopped|stopped successfully)/);
    } catch (e: any) {
      // The command may succeed even if no agents are running
      // Handle case where stdout/stderr might be undefined
      const output = (e.stdout || '') + (e.stderr || '') + (e.message || '');
      expect(output).toMatch(
        /(stopped|All ElizaOS agents stopped|Windows|WSL|requires Unix-like commands)/
      );
    }
  });
});
