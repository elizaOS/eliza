import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Subprocess } from 'bun';

// Mock dependencies
const spawnSpy = spyOn(Bun, 'spawn');
const mockExistsSync = mock();
const mockLogger = {
  info: mock(),
  debug: mock(),
  error: mock(),
};

mock.module('node:fs', () => ({
  existsSync: mockExistsSync,
}));

mock.module('@elizaos/core', () => ({
  logger: mockLogger,
}));

// Import the module after mocking
import {
  tryDelegateToLocalCli,
  hasLocalCli,
  getCliContext,
} from '../../../src/utils/local-cli-delegation';

// Helper to create a mock subprocess
function createMockSubprocess(exitCode: number = 0, signal: NodeJS.Signals | null = null, error?: Error) {
  const mockProcess = {
    // Required properties
    stdin: null as any,
    stdout: null as any,
    stderr: null as any,
    stdio: [] as any,
    exitCode: exitCode as number | null,
    signalCode: signal,
    pid: 12345,
    killed: false,
    ref() {},
    unref() {},
    // Simulate exited promise - resolves after a small delay to trigger process.exit
    exited: error 
      ? Promise.reject(error) 
      : new Promise<number>((resolve) => {
          setTimeout(() => {
            resolve(exitCode);
          }, 10);
        }),
    
    // Kill method
    kill: mock((sig?: NodeJS.Signals) => {
      // Cannot modify readonly properties - they're already set correctly
      return true;
    }),
  } as unknown as Subprocess;
  
  return mockProcess;
}

describe('Local CLI Delegation', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalArgv: string[];
  let originalCwd: typeof process.cwd;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    // Save original environment and process methods
    originalEnv = { ...process.env };
    originalArgv = [...process.argv];
    originalCwd = process.cwd;
    originalExit = process.exit;

    // Reset all mocks
    spawnSpy.mockReset();
    mockExistsSync.mockReset();
    mockLogger.info.mockReset();
    mockLogger.debug.mockReset();
    mockLogger.error.mockReset();

    // Mock process.cwd
    process.cwd = mock(() => '/test/project');

    // Mock process.exit - just track calls, don't throw
    process.exit = mock((code?: number) => {
      // In tests, just track the call but don't actually exit
    }) as any;

    // Clear test environment variables
    delete process.env.NODE_ENV;
    delete process.env.ELIZA_TEST_MODE;
    delete process.env.BUN_TEST;
    delete process.env.VITEST;
    delete process.env.JEST_WORKER_ID;
    delete process.env.npm_lifecycle_event;
    delete process.env.ELIZA_SKIP_LOCAL_CLI_DELEGATION;
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
  });

  afterEach(() => {
    // Restore original environment completely
    process.env = originalEnv;
    process.argv = originalArgv;
    process.cwd = originalCwd;
    process.exit = originalExit;

    // Clear any module cache that might affect other tests
    spawnSpy.mockClear();
    mockExistsSync.mockClear();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.error.mockClear();
  });

  describe('Test Environment Detection', () => {
    it('should skip delegation when NODE_ENV is test', async () => {
      process.env.NODE_ENV = 'test';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('should skip delegation when ELIZA_TEST_MODE is true', async () => {
      process.env.ELIZA_TEST_MODE = 'true';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('should skip delegation when BUN_TEST is true', async () => {
      process.env.BUN_TEST = 'true';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('should skip delegation when VITEST is true', async () => {
      process.env.VITEST = 'true';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('should skip delegation when JEST_WORKER_ID is set', async () => {
      process.env.JEST_WORKER_ID = '1';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('should skip delegation when npm_lifecycle_event is test', async () => {
      process.env.npm_lifecycle_event = 'test';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('should skip delegation when --test is in process.argv', async () => {
      process.argv = ['bun', 'script.js', '--test'];
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('should skip delegation when test is in process.argv', async () => {
      process.argv = ['bun', 'script.js', 'test'];
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('should skip delegation when script path includes test', async () => {
      process.argv = ['bun', '/path/to/test/script.js', 'start'];
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('should skip delegation when ELIZA_SKIP_LOCAL_CLI_DELEGATION is true', async () => {
      process.env.ELIZA_SKIP_LOCAL_CLI_DELEGATION = 'true';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('should skip delegation when CI is true', async () => {
      process.env.CI = 'true';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('should skip delegation when GITHUB_ACTIONS is true', async () => {
      process.env.GITHUB_ACTIONS = 'true';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('should skip delegation when GITLAB_CI is true', async () => {
      process.env.GITLAB_CI = 'true';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });
  });

  describe('Update Command Detection', () => {
    it('should skip delegation when update command is used', async () => {
      const originalArgv = process.argv;
      process.argv = ['bun', 'script.js', 'update'];
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Update command detected, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();

      process.argv = originalArgv;
    });

    it('should skip delegation when update command is used with flags', async () => {
      const originalArgv = process.argv;
      process.argv = ['bun', 'script.js', 'update', '--check'];
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Update command detected, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();

      process.argv = originalArgv;
    });
  });

  describe('Version Command Detection', () => {
    it('should skip delegation when -v flag is used', async () => {
      const originalArgv = process.argv;
      process.argv = ['bun', 'script.js', '-v'];
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Version command detected, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();

      process.argv = originalArgv;
    });

    it('should skip delegation when --version flag is used', async () => {
      const originalArgv = process.argv;
      process.argv = ['bun', 'script.js', '--version'];
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Version command detected, skipping local CLI delegation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();

      process.argv = originalArgv;
    });
  });

  describe('Local CLI Detection', () => {
    it('should detect when running from local CLI', async () => {
      // Clear test environment variables to test local CLI detection
      delete process.env.NODE_ENV;
      delete process.env.ELIZA_TEST_MODE;
      delete process.env.BUN_TEST;
      delete process.env.VITEST;
      delete process.env.JEST_WORKER_ID;
      delete process.env.npm_lifecycle_event;
      // Also clear process.argv to avoid test-related detection
      process.argv = ['bun', '/test/project/node_modules/@elizaos/cli/dist/index.js', 'start'];
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('should continue when no local CLI is found', async () => {
      process.argv = ['bun', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(false);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'No local CLI found, using global installation'
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('should delegate when local CLI is found and not running from it', async () => {
      process.argv = ['bun', '/usr/bin/elizaos', 'start', '--port', '3000'];
      mockExistsSync.mockReturnValue(true);

      // Mock successful spawn
      const mockChildProcess = createMockSubprocess(0);
      spawnSpy.mockReturnValue(mockChildProcess);

      const result = await tryDelegateToLocalCli();
      
      // Function returns true when delegation happens
      expect(result).toBe(true);
      
      // Wait for the async process.exit to be called
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(mockLogger.info).toHaveBeenCalledWith('Using local @elizaos/cli installation');
      expect(spawnSpy).toHaveBeenCalledWith(
        [process.execPath, '/test/project/node_modules/@elizaos/cli/dist/index.js', 'start', '--port', '3000'],
        expect.objectContaining({
          stdio: ['inherit', 'inherit', 'inherit'],
          cwd: '/test/project',
          env: expect.objectContaining({
            FORCE_COLOR: '1',
          }),
        })
      );
      expect(process.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('Environment Setup', () => {
    it('should set up proper environment variables for local execution', async () => {
      process.argv = ['bun', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      // Mock successful spawn
      const mockChildProcess = createMockSubprocess(0);
      spawnSpy.mockReturnValue(mockChildProcess);

      const result = await tryDelegateToLocalCli();
      expect(result).toBe(true);
      
      // Wait for the async process.exit to be called
      await new Promise(resolve => setTimeout(resolve, 20));

      const spawnCall = spawnSpy.mock.calls[0];
      const spawnOptions = spawnCall?.[1]; // Bun.spawn takes [cmd, ...args] as first arg, options as second
      const env = spawnOptions?.env;

      expect(env?.FORCE_COLOR).toBe('1');
      expect(env?.NODE_PATH).toContain('/test/project/node_modules');
      expect(env?.PATH).toContain('/test/project/node_modules/.bin');
    });

    it('should preserve existing NODE_PATH and PATH', async () => {
      process.env.NODE_PATH = '/existing/node/path';
      process.env.PATH = '/existing/bin/path';
      process.argv = ['bun', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      // Mock successful spawn
      const mockChildProcess = createMockSubprocess(0);
      spawnSpy.mockReturnValue(mockChildProcess);

      const result = await tryDelegateToLocalCli();
      expect(result).toBe(true);
      
      // Wait for the async process.exit to be called
      await new Promise(resolve => setTimeout(resolve, 20));

      const spawnCall = spawnSpy.mock.calls[0];
      const spawnOptions = spawnCall?.[1]; // Bun.spawn takes [cmd, ...args] as first arg, options as second
      const env = spawnOptions?.env;

      expect(env?.NODE_PATH).toContain('/test/project/node_modules');
      expect(env?.NODE_PATH).toContain('/existing/node/path');
      expect(env?.PATH).toContain('/test/project/node_modules/.bin');
      expect(env?.PATH).toContain('/existing/bin/path');
    });
  });

  describe('Error Handling', () => {
    it('should handle spawn errors gracefully', async () => {
      process.argv = ['bun', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      const testError = new Error('Spawn failed');
      spawnSpy.mockImplementation(() => {
        throw testError;
      });

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error during local CLI delegation:',
        testError.message
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Falling back to global CLI installation');
    });

    it('should handle process errors', async () => {
      process.argv = ['bun', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      const testError = new Error('Process error');
      const mockChildProcess = createMockSubprocess(0, null, testError);
      spawnSpy.mockReturnValue(mockChildProcess);

      try {
        await tryDelegateToLocalCli();
      } catch (error) {
        expect(error).toBe(testError);
      }

      expect(mockLogger.error).toHaveBeenCalledWith('Failed to start local CLI:', 'Process error');
    });
  });

  describe('Utility Functions', () => {
    it('hasLocalCli should return true when local CLI exists', () => {
      mockExistsSync.mockReturnValue(true);
      expect(hasLocalCli()).toBe(true);
    });

    it('hasLocalCli should return false when local CLI does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(hasLocalCli()).toBe(false);
    });

    it('getCliContext should return correct context information', () => {
      process.argv = ['bun', '/test/project/node_modules/@elizaos/cli/dist/index.js', 'start'];
      mockExistsSync.mockReturnValue(true);

      const context = getCliContext();

      expect(context.isLocal).toBe(true);
      expect(context.hasLocal).toBe(true);
      expect(context.localPath).toBe('/test/project/node_modules/@elizaos/cli/dist/index.js');
      expect(context.currentPath).toBe('/test/project/node_modules/@elizaos/cli/dist/index.js');
    });

    it('getCliContext should return correct context when not running from local CLI', () => {
      process.argv = ['bun', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(false);

      const context = getCliContext();

      expect(context.isLocal).toBe(false);
      expect(context.hasLocal).toBe(false);
      expect(context.localPath).toBe(null);
      expect(context.currentPath).toBe('/usr/bin/elizaos');
    });
  });

  describe('Process Exit Handling', () => {
    it('should exit with child process exit code', async () => {
      process.argv = ['bun', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      const mockChildProcess = createMockSubprocess(42);
      spawnSpy.mockReturnValue(mockChildProcess);

      const result = await tryDelegateToLocalCli();
      expect(result).toBe(true);
      
      // Wait for the async process.exit to be called
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(process.exit).toHaveBeenCalledWith(42);
    });

    it('should exit with appropriate code when killed by signal', async () => {
      process.argv = ['bun', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      const mockChildProcess = createMockSubprocess(0, 'SIGTERM');
      spawnSpy.mockReturnValue(mockChildProcess);

      const result = await tryDelegateToLocalCli();
      expect(result).toBe(true);
      
      // Wait for the async process.exit to be called
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(process.exit).toHaveBeenCalledWith(143);
    });

    it('should exit with 130 for SIGINT', async () => {
      process.argv = ['bun', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      const mockChildProcess = createMockSubprocess(0, 'SIGINT');
      spawnSpy.mockReturnValue(mockChildProcess);

      const result = await tryDelegateToLocalCli();
      expect(result).toBe(true);
      
      // Wait for the async process.exit to be called
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(process.exit).toHaveBeenCalledWith(130);
    });

    it('should exit with 128 for unknown signal', async () => {
      process.argv = ['bun', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      const mockChildProcess = createMockSubprocess(0, 'SIGUSR1' as NodeJS.Signals);
      spawnSpy.mockReturnValue(mockChildProcess);

      const result = await tryDelegateToLocalCli();
      expect(result).toBe(true);
      
      // Wait for the async process.exit to be called
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(process.exit).toHaveBeenCalledWith(128);
    });
  });
});
