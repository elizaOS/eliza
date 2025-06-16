import { execSync } from 'child_process';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_TIMEOUTS } from '../test-timeouts';
import { safeChangeDirectory, TestProcessManager, waitForServerReady } from './test-utils';

describe('ElizaOS Start Commands', () => {
  let testTmpDir: string;
  let elizaosCmd: string;
  let originalCwd: string;
  let testServerPort: number;
  let processManager: TestProcessManager;

  beforeEach(async () => {
    // Store original working directory
    originalCwd = process.cwd();
    
    // Initialize process manager
    processManager = new TestProcessManager();

    // ---- Ensure port is free.
    testServerPort = 3000;
    try {
      if (process.platform === 'win32') {
        // Windows: Use netstat and taskkill to free the port
        execSync(
          `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${testServerPort}') do taskkill /f /pid %a`,
          { stdio: 'ignore' }
        );
      } else {
        // Unix/Linux/macOS: Use lsof and kill
        execSync(`lsof -t -i :${testServerPort} | xargs kill -9`, { stdio: 'ignore' });
      }
      await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));
    } catch (e) {
      // Ignore if no processes found
    }

    // Create temporary directory
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-start-'));
    process.chdir(testTmpDir);

    // Setup CLI command
    const scriptDir = join(__dirname, '..');
    elizaosCmd = `bun ${join(scriptDir, '../dist/index.js')}`;

    // Make PORT + model envs explicit.
    process.env.LOCAL_SMALL_MODEL = 'DeepHermes-3-Llama-3-3B-Preview-q4.gguf';
    process.env.LOCAL_MEDIUM_MODEL = process.env.LOCAL_SMALL_MODEL;
    process.env.TEST_SERVER_PORT = testServerPort.toString();
  });

  afterEach(async () => {
    // Clean up all processes
    await processManager.cleanup();

    // Clean up environment variables
    delete process.env.LOCAL_SMALL_MODEL;
    delete process.env.LOCAL_MEDIUM_MODEL;
    delete process.env.TEST_SERVER_PORT;

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
          LOG_LEVEL: 'debug',
          PGLITE_DATA_DIR: join(testTmpDir, 'elizadb'),
          SERVER_PORT: testServerPort.toString(),
        },
        cwd: testTmpDir,
      }
    );

    // Wait for server to be ready
    await waitForServerReady(testServerPort, maxWaitTime);
    
    // Check if process is still running after startup
    if (serverProcess.killed || serverProcess.exitCode !== null) {
      throw new Error('Server process died during startup');
    }

    return serverProcess;
  };

  // Basic agent check
  it('start command shows help', () => {
    const result = execSync(`${elizaosCmd} start --help`, { encoding: 'utf8' });
    expect(result).toContain('Usage: elizaos start');
    expect(result).toContain('--character');
    expect(result).toContain('--port');
  });

  it(
    'start and list shows Ada agent running',
    async () => {
      const charactersDir = join(__dirname, '../test-characters');
      const adaPath = join(charactersDir, 'ada.json');

      // Start a temporary server with Ada character
      const serverProcess = await startServerAndWait(
        `-p ${testServerPort} --character ${adaPath}`
      );

      try {
        // Wait a bit more for agent to register
        await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));

        // Test that agent list shows Ada
        const result = execSync(
          `${elizaosCmd} agent list --remote-url http://localhost:${testServerPort}`,
          {
            encoding: 'utf8',
            timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
          }
        );

        expect(result).toContain('Ada');
      } finally {
        // Clean up server
        serverProcess.kill();
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
          },
          cwd: testTmpDir,
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
  it('multiple character formats parse', () => {
    const charactersDir = join(__dirname, '../test-characters');
    const adaPath = join(charactersDir, 'ada.json');

    const formats = [',', ' '];

    for (const fmt of formats) {
      const result = execSync(
        `${elizaosCmd} start --character "${adaPath}${fmt}${adaPath}" --help`,
        { encoding: 'utf8' }
      );
      expect(result).toContain('start');
    }
  });

  // Mixed valid/invalid files should not crash CLI when running with --help (dry)
  it('graceful acceptance of invalid character file list (dry)', () => {
    const charactersDir = join(__dirname, '../test-characters');
    const adaPath = join(charactersDir, 'ada.json');

    const result = execSync(
      `${elizaosCmd} start --character "${adaPath},does-not-exist.json" --help`,
      { encoding: 'utf8' }
    );
    expect(result).toContain('start');
  });

  // --build flag accepted
  it('build option flag accepted', () => {
    const result = execSync(`${elizaosCmd} start --build --help`, { encoding: 'utf8' });
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
        [
          join(__dirname, '..', '../dist/index.js'),
          'start',
          '--configure',
          '--character',
          adaPath,
        ],
        {
          env: {
            ...process.env,
            LOG_LEVEL: 'debug',
            PGLITE_DATA_DIR: join(testTmpDir, 'elizadb3'),
          },
          cwd: testTmpDir,
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
      const serverProcess = await startServerAndWait(
        `-p ${testServerPort} --character ${adaPath}`
      );

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
});
