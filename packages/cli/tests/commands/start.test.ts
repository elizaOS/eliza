import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { TEST_TIMEOUTS } from '../test-timeouts';
import {
  getPlatformOptions,
  killProcessOnPort,
  safeChangeDirectory,
  TestProcessManager,
  waitForServerReady,
} from './test-utils';

describe('ElizaOS Start Commands', () => {
  let testTmpDir: string;
  let elizaosCmd: string;
  let originalCwd: string;
  let testServerPort: number;
  let processManager: TestProcessManager;
  let originalElizaTestMode: string | undefined;

  beforeEach(async () => {
    // Store original working directory
    originalCwd = process.cwd();

    // Store original ELIZA_TEST_MODE
    originalElizaTestMode = process.env.ELIZA_TEST_MODE;

    // Initialize process manager
    processManager = new TestProcessManager();

    // ---- Ensure port is free.
    testServerPort = 3000;
    await killProcessOnPort(testServerPort);
    await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));

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

  // Helper function to create a project structure for build testing
  const createProjectStructure = async (hasPackageJson = true, hasBuildScript = true) => {
    if (hasPackageJson) {
      const packageJson = {
        name: 'test-eliza-project',
        version: '1.0.0',
        scripts: hasBuildScript ? { build: 'echo "Building..." && mkdir -p dist && echo "Build complete"' } : {},
        dependencies: {
          '@elizaos/core': '^1.0.0',
        },
      };
      await writeFile(join(testTmpDir, 'package.json'), JSON.stringify(packageJson, null, 2));
    }

    // Create src directory and basic files
    await mkdir(join(testTmpDir, 'src'), { recursive: true });
    await writeFile(join(testTmpDir, 'src', 'index.ts'), 'export default {};');

    // Create test character file
    const charactersDir = join(__dirname, '../test-characters');
    const adaPath = join(charactersDir, 'ada.json');
    return adaPath;
  };

  // Basic agent check
  it('start command shows help', () => {
    const result = execSync(`${elizaosCmd} start --help`, getPlatformOptions({ encoding: 'utf8' }));
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
            const platformOptions = getPlatformOptions({
              encoding: 'utf8',
              timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
            });

            result = execSync(
              `${elizaosCmd} agent list --remote-url http://localhost:${testServerPort}`,
              platformOptions
            );

            // If we get a result, check if it contains Ada
            if (result && result.includes('Ada')) {
              break;
            }

            // If we don't have Ada but no error, wait and retry
            if (i < maxRetries - 1) {
              await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));
            }
          } catch (error: any) {
            lastError = error;
            // If command failed and we have retries left, wait and retry
            if (i < maxRetries - 1) {
              await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.MEDIUM_WAIT));
            }
          }
        }

        // If we never got a successful result with Ada, throw the last error
        if (!result || !result.includes('Ada')) {
          if (lastError) {
            throw lastError;
          }
          throw new Error(
            `Agent list did not contain 'Ada' after ${maxRetries} retries. Output: ${result}`
          );
        }

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
        getPlatformOptions({ encoding: 'utf8' })
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
      getPlatformOptions({ encoding: 'utf8' })
    );
    expect(result).toContain('start');
  });

  // --build flag accepted
  it('build option flag accepted', () => {
    const result = execSync(
      `${elizaosCmd} start --build --help`,
      getPlatformOptions({ encoding: 'utf8' })
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

  // Auto-build functionality tests
  describe('Auto-build functionality', () => {
    let buildProjectMock: any;
    let buildProjectCalls: Array<{ cwd: string; isPlugin: boolean }> = [];

    beforeEach(() => {
      // Create mock that tracks calls
      buildProjectCalls = [];
      buildProjectMock = mock((cwd: string, isPlugin: boolean) => {
        buildProjectCalls.push({ cwd, isPlugin });
        return Promise.resolve();
      });

      // Mock the buildProject function
      mock.module('@/src/utils/build-project', () => ({
        buildProject: buildProjectMock,
      }));
    });

    afterEach(() => {
      buildProjectCalls = [];
    });

    it('should automatically build project when not in monorepo and not in test mode', async () => {
      // Create a project structure with build script
      const adaPath = await createProjectStructure(true, true);

      // Temporarily unset ELIZA_TEST_MODE to test auto-build
      const originalTestMode = process.env.ELIZA_TEST_MODE;
      delete process.env.ELIZA_TEST_MODE;

      try {
        // Mock monorepo detection to return null (not in monorepo)
        const mockUserEnvironment = {
          getInstance: mock(() => ({
            findMonorepoRoot: mock(() => null),
          })),
        };
        mock.module('@/src/utils/user-environment', () => mockUserEnvironment);

        // Execute the start command without --help
        const result = execSync(
          `${elizaosCmd} start --character ${adaPath}`,
          getPlatformOptions({ encoding: 'utf8' })
        );

        // Verify buildProject was called
        expect(buildProjectMock).toHaveBeenCalledTimes(1);
        expect(buildProjectCalls[0]).toEqual({
          cwd: process.cwd(),
          isPlugin: false,
        });

        // Verify the command executed (should contain some output)
        expect(result).toBeTruthy();
      } finally {
        // Restore test mode
        if (originalTestMode) {
          process.env.ELIZA_TEST_MODE = originalTestMode;
        } else {
          delete process.env.ELIZA_TEST_MODE;
        }
      }
    });

    it('should skip build when ELIZA_TEST_MODE is set to true', async () => {
      // Create a project structure with build script
      const adaPath = await createProjectStructure(true, true);

      // Explicitly set ELIZA_TEST_MODE to 'true'
      const originalTestMode = process.env.ELIZA_TEST_MODE;
      process.env.ELIZA_TEST_MODE = 'true';

      try {
        // Mock monorepo detection to return null (not in monorepo)
        const mockUserEnvironment = {
          getInstance: mock(() => ({
            findMonorepoRoot: mock(() => null),
          })),
        };
        mock.module('@/src/utils/user-environment', () => mockUserEnvironment);

        const result = execSync(
          `${elizaosCmd} start --character ${adaPath}`,
          getPlatformOptions({ encoding: 'utf8' })
        );

        // Verify buildProject was NOT called due to test mode
        expect(buildProjectMock).not.toHaveBeenCalled();

        // Verify the command executed
        expect(result).toBeTruthy();
      } finally {
        // Restore original test mode
        if (originalTestMode) {
          process.env.ELIZA_TEST_MODE = originalTestMode;
        } else {
          delete process.env.ELIZA_TEST_MODE;
        }
      }
    });

    it('should skip build when ELIZA_TEST_MODE is set to any truthy value', async () => {
      // Create a project structure with build script
      const adaPath = await createProjectStructure(true, true);

      // Test with different truthy values
      const truthyValues = ['1', 'yes', 'on', 'enabled'];

      for (const value of truthyValues) {
        // Reset mock calls
        buildProjectCalls = [];

        const originalTestMode = process.env.ELIZA_TEST_MODE;
        process.env.ELIZA_TEST_MODE = value;

        try {
          // Mock monorepo detection to return null (not in monorepo)
          const mockUserEnvironment = {
            getInstance: mock(() => ({
              findMonorepoRoot: mock(() => null),
            })),
          };
          mock.module('@/src/utils/user-environment', () => mockUserEnvironment);

          const result = execSync(
            `${elizaosCmd} start --character ${adaPath}`,
            getPlatformOptions({ encoding: 'utf8' })
          );

          // Verify buildProject was NOT called due to test mode
          expect(buildProjectMock).not.toHaveBeenCalled();

          // Verify the command executed
          expect(result).toBeTruthy();
        } finally {
          // Restore original test mode
          if (originalTestMode) {
            process.env.ELIZA_TEST_MODE = originalTestMode;
          } else {
            delete process.env.ELIZA_TEST_MODE;
          }
        }
      }
    });

    it('should skip build when in monorepo directory', async () => {
      // Create a project structure with build script
      const adaPath = await createProjectStructure(true, true);

      // Temporarily unset ELIZA_TEST_MODE to test monorepo detection
      const originalTestMode = process.env.ELIZA_TEST_MODE;
      delete process.env.ELIZA_TEST_MODE;

      try {
        // Mock monorepo detection to return a monorepo root
        const mockUserEnvironment = {
          getInstance: mock(() => ({
            findMonorepoRoot: mock(() => '/path/to/monorepo'),
          })),
        };
        mock.module('@/src/utils/user-environment', () => mockUserEnvironment);

        const result = execSync(
          `${elizaosCmd} start --character ${adaPath}`,
          getPlatformOptions({ encoding: 'utf8' })
        );

        // Verify buildProject was NOT called due to monorepo detection
        expect(buildProjectMock).not.toHaveBeenCalled();

        // Verify the command executed
        expect(result).toBeTruthy();
      } finally {
        // Restore test mode
        if (originalTestMode) {
          process.env.ELIZA_TEST_MODE = originalTestMode;
        } else {
          delete process.env.ELIZA_TEST_MODE;
        }
      }
    });

    it('should handle build errors gracefully and continue with start', async () => {
      // Create a project structure with build script
      const adaPath = await createProjectStructure(true, true);

      // Temporarily unset ELIZA_TEST_MODE to test auto-build
      const originalTestMode = process.env.ELIZA_TEST_MODE;
      delete process.env.ELIZA_TEST_MODE;

      try {
        // Mock monorepo detection to return null (not in monorepo)
        const mockUserEnvironment = {
          getInstance: mock(() => ({
            findMonorepoRoot: mock(() => null),
          })),
        };
        mock.module('@/src/utils/user-environment', () => mockUserEnvironment);

        // Mock buildProject to throw an error
        const buildProjectErrorMock = mock(() => Promise.reject(new Error('Build failed')));
        mock.module('@/src/utils/build-project', () => ({
          buildProject: buildProjectErrorMock,
        }));

        const result = execSync(
          `${elizaosCmd} start --character ${adaPath}`,
          getPlatformOptions({ encoding: 'utf8' })
        );

        // Verify buildProject was called (attempted to build)
        expect(buildProjectErrorMock).toHaveBeenCalledTimes(1);

        // Verify the command still executed despite build error
        expect(result).toBeTruthy();
      } finally {
        // Restore test mode
        if (originalTestMode) {
          process.env.ELIZA_TEST_MODE = originalTestMode;
        } else {
          delete process.env.ELIZA_TEST_MODE;
        }
      }
    });
  });
});
