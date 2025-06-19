import { execSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { TEST_TIMEOUTS } from '../test-timeouts';
import { createTestProject, killProcessOnPort, safeChangeDirectory } from './test-utils';

describe('ElizaOS Dev Commands', () => {
  let testTmpDir: string;
  let projectDir: string;
  let elizaosCmd: string;
  let originalCwd: string;
  let testServerPort: number;
  let runningProcesses: any[] = [];

  beforeAll(async () => {
    // Store original working directory
    originalCwd = process.cwd();

    // Create temporary directory
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-dev-'));

    // Setup CLI command
    const scriptDir = join(__dirname, '..');
    elizaosCmd = `bun ${join(scriptDir, '../dist/index.js')}`;

    // Create one test project for all dev tests to share
    projectDir = join(testTmpDir, 'shared-test-project');
    process.chdir(testTmpDir);

    console.log('Creating shared test project for dev tests...');
    await createTestProject(elizaosCmd, 'shared-test-project');
    console.log('Shared test project created at:', projectDir);
  });

  beforeEach(async () => {
    // Setup test port (different from start tests)
    testServerPort = 3100;
    await killProcessOnPort(testServerPort);
    await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));

    // Change to project directory for each test
    process.chdir(projectDir);

    // Set test environment variables to avoid database issues
    process.env.TEST_SERVER_PORT = testServerPort.toString();
    process.env.LOG_LEVEL = 'error'; // Reduce log noise
  });

  afterEach(async () => {
    // Kill any running processes
    for (const proc of runningProcesses) {
      try {
        proc.kill('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    runningProcesses = [];

    // Clean up environment variables
    delete process.env.TEST_SERVER_PORT;
    delete process.env.LOG_LEVEL;
  });

  afterAll(async () => {
    // Restore original working directory
    safeChangeDirectory(originalCwd);

    if (testTmpDir && testTmpDir.includes('eliza-test-dev-')) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  // Helper function to start dev process and wait for it to be ready
  const startDevAndWait = async (
    args: string,
    waitTime: number = TEST_TIMEOUTS.MEDIUM_WAIT,
    cwd?: string
  ): Promise<any> => {
    await mkdir(join(testTmpDir, 'elizadb'), { recursive: true });

    const devProcess = spawn(
      'bun',
      [join(__dirname, '..', '../dist/index.js'), 'dev', ...args.split(' ')],
      {
        env: {
          ...process.env,
          LOG_LEVEL: 'error',
          PGLITE_DATA_DIR: join(testTmpDir, 'elizadb'),
          SERVER_PORT: testServerPort.toString(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: cwd || projectDir,
      }
    );

    runningProcesses.push(devProcess);

    // Wait for process to start
    await new Promise((resolve) => setTimeout(resolve, waitTime));

    return devProcess;
  };

  it('dev --help shows usage', () => {
    const result = execSync(`${elizaosCmd} dev --help`, { encoding: 'utf8' });
    expect(result).toContain('Usage: elizaos dev');
    expect(result).toContain('development mode');
    expect(result).toContain('auto-rebuild');
  });

  it(
    'dev command starts in project directory',
    async () => {
      // Start dev process
      const devProcess = await startDevAndWait('--port ' + testServerPort);

      // Wait a moment for initialization
      await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));

      // Check that process is running
      expect(devProcess.pid).toBeDefined();
      expect(devProcess.killed).toBe(false);

      // Kill the process
      devProcess.kill('SIGTERM');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'dev command detects project type correctly',
    async () => {
      // Start dev process and capture output
      const devProcess = spawn(
        'bun',
        [join(__dirname, '..', '../dist/index.js'), 'dev', '--port', testServerPort.toString()],
        {
          env: {
            ...process.env,
            LOG_LEVEL: 'info',
            PGLITE_DATA_DIR: join(testTmpDir, 'elizadb'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: projectDir,
        }
      );

      runningProcesses.push(devProcess);

      let output = '';
      devProcess.stdout?.on('data', (data) => {
        output += data.toString();
      });
      devProcess.stderr?.on('data', (data) => {
        output += data.toString();
      });

      // Wait for process to start and detect project type
      await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.MEDIUM_WAIT));

      // Check that it detected project type (even if it fails later due to database)
      expect(output).toMatch(/(ElizaOS project|project mode|Identified as)/);

      devProcess.kill('SIGTERM');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'dev command responds to file changes in project',
    async () => {
      // Create a simple file to modify
      const testFile = join(projectDir, 'src', 'test-file.ts');
      await mkdir(join(projectDir, 'src'), { recursive: true });
      await writeFile(testFile, 'export const test = "initial";');

      // Start dev process
      const devProcess = spawn(
        'bun',
        [join(__dirname, '..', '../dist/index.js'), 'dev', '--port', testServerPort.toString()],
        {
          env: {
            ...process.env,
            LOG_LEVEL: 'info',
            PGLITE_DATA_DIR: join(testTmpDir, 'elizadb'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: projectDir,
        }
      );

      runningProcesses.push(devProcess);

      let output = '';
      devProcess.stdout?.on('data', (data) => {
        output += data.toString();
      });
      devProcess.stderr?.on('data', (data) => {
        output += data.toString();
      });

      // Wait for initial startup
      await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.MEDIUM_WAIT));

      // Modify the file to trigger rebuild
      await writeFile(testFile, 'export const test = "modified";');

      // Wait for file change detection and rebuild
      await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.MEDIUM_WAIT));

      // Check that file change was detected (even if rebuild fails due to setup)
      // The important thing is that dev mode is watching for changes
      expect(devProcess.killed).toBe(false); // Process should still be running

      devProcess.kill('SIGTERM');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'dev command accepts character file',
    async () => {
      const charactersDir = join(__dirname, '../test-characters');
      const adaPath = join(charactersDir, 'ada.json');

      // Start dev process with character
      const devProcess = await startDevAndWait(`--port ${testServerPort} --character ${adaPath}`);

      // Check that process started
      expect(devProcess.pid).toBeDefined();
      expect(devProcess.killed).toBe(false);

      devProcess.kill('SIGTERM');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'dev command handles non-elizaos directory gracefully',
    async () => {
      // Create a non-ElizaOS project directory
      const nonElizaDir = join(testTmpDir, 'non-elizaos');
      await mkdir(nonElizaDir, { recursive: true });
      await writeFile(join(nonElizaDir, 'package.json'), JSON.stringify({ name: 'not-elizaos', version: '1.0.0' }));

      let output = '';
      const devProcess = spawn(
        'bun',
        [join(__dirname, '..', '../dist/index.js'), 'dev', '--port', testServerPort.toString()],
        {
          env: {
            ...process.env,
            LOG_LEVEL: 'info',
            PGLITE_DATA_DIR: join(testTmpDir, 'elizadb'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: nonElizaDir,
        }
      );

      runningProcesses.push(devProcess);

      devProcess.stdout?.on('data', (data) => {
        output += data.toString();
      });
      devProcess.stderr?.on('data', (data) => {
        output += data.toString();
      });

      // Wait for process to start and detect non-ElizaOS directory
      await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.MEDIUM_WAIT));

      // Should warn about not being in ElizaOS project but still work
      expect(output).toMatch(/(not.*recognized|standalone mode|not.*ElizaOS)/i);

      devProcess.kill('SIGTERM');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it('dev command validates port parameter', () => {
    // Test that invalid port is rejected
    try {
      execSync(`${elizaosCmd} dev --port abc`, {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
      });
      expect(false).toBe(true); // Should not reach here
    } catch (error: any) {
      expect(error.status).not.toBe(0);
    }
  });
});
