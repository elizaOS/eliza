import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Mock dependencies
const mockSpawn = mock();
const mockExistsSync = mock();
const mockLogger = {
  info: mock(),
  debug: mock(),
  error: mock(),
};

// Mock modules
mock.module('node:child_process', () => ({
  spawn: mockSpawn,
}));

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

describe('Local CLI Delegation', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalArgv: string[];
  let originalCwd: string;
  let mockProcess: any;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    originalArgv = [...process.argv];
    originalCwd = process.cwd();

    // Reset mocks
    mockSpawn.mockReset();
    mockExistsSync.mockReset();
    mockLogger.info.mockReset();
    mockLogger.debug.mockReset();
    mockLogger.error.mockReset();

    // Mock process.cwd
    jest.spyOn(process, 'cwd').mockReturnValue('/test/project');

    // Mock process.exit
    mockProcess = {
      exit: mock(),
    };
    jest.spyOn(process, 'exit').mockImplementation(mockProcess.exit);

    // Clear test environment variables
    delete process.env.NODE_ENV;
    delete process.env.ELIZA_TEST_MODE;
    delete process.env.BUN_TEST;
    delete process.env.VITEST;
    delete process.env.JEST_WORKER_ID;
    delete process.env.npm_lifecycle_event;
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    process.argv = originalArgv;

    // Restore mocks
    jest.restoreAllMocks();
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
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should skip delegation when ELIZA_TEST_MODE is true', async () => {
      process.env.ELIZA_TEST_MODE = 'true';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should skip delegation when BUN_TEST is true', async () => {
      process.env.BUN_TEST = 'true';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should skip delegation when VITEST is true', async () => {
      process.env.VITEST = 'true';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should skip delegation when JEST_WORKER_ID is set', async () => {
      process.env.JEST_WORKER_ID = '1';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should skip delegation when npm_lifecycle_event is test', async () => {
      process.env.npm_lifecycle_event = 'test';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should skip delegation when --test is in process.argv', async () => {
      process.argv = ['node', 'script.js', '--test'];
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should skip delegation when test is in process.argv', async () => {
      process.argv = ['node', 'script.js', 'test'];
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should skip delegation when script path includes test', async () => {
      process.argv = ['node', '/path/to/test/script.js', 'start'];
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should skip delegation when ELIZA_SKIP_LOCAL_CLI_DELEGATION is true', async () => {
      process.env.ELIZA_SKIP_LOCAL_CLI_DELEGATION = 'true';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should skip delegation when CI is true', async () => {
      process.env.CI = 'true';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should skip delegation when GITHUB_ACTIONS is true', async () => {
      process.env.GITHUB_ACTIONS = 'true';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should skip delegation when GITLAB_CI is true', async () => {
      process.env.GITLAB_CI = 'true';
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running in test or CI environment, skipping local CLI delegation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('Update Command Detection', () => {
    it('should skip delegation when update command is used', async () => {
      const originalArgv = process.argv;
      process.argv = ['node', 'script.js', 'update'];
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Update command detected, skipping local CLI delegation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();

      process.argv = originalArgv;
    });

    it('should skip delegation when update command is used with flags', async () => {
      const originalArgv = process.argv;
      process.argv = ['node', 'script.js', 'update', '--check'];
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Update command detected, skipping local CLI delegation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();

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
      process.argv = ['node', '/test/project/node_modules/@elizaos/cli/dist/index.js', 'start'];
      mockExistsSync.mockReturnValue(true);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should continue when no local CLI is found', async () => {
      process.argv = ['node', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(false);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'No local CLI found, using global installation'
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should delegate when local CLI is found and not running from it', async () => {
      process.argv = ['node', '/usr/bin/elizaos', 'start', '--port', '3000'];
      mockExistsSync.mockReturnValue(true);

      // Mock successful spawn
      const mockChildProcess = {
        on: mock((event: string, handler: Function) => {
          if (event === 'exit') {
            // Simulate successful exit
            setTimeout(() => handler(0, null), 10);
          }
        }),
        kill: mock(),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith('Using local @elizaos/cli installation');
      expect(mockSpawn).toHaveBeenCalledWith(
        process.execPath,
        ['/test/project/node_modules/@elizaos/cli/dist/index.js', 'start', '--port', '3000'],
        expect.objectContaining({
          stdio: 'inherit',
          cwd: '/test/project',
          env: expect.objectContaining({
            FORCE_COLOR: '1',
          }),
        })
      );
    });
  });

  describe('Environment Setup', () => {
    it('should set up proper environment variables for local execution', async () => {
      process.argv = ['node', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      // Mock successful spawn
      const mockChildProcess = {
        on: mock((event: string, handler: Function) => {
          if (event === 'exit') {
            setTimeout(() => handler(0, null), 10);
          }
        }),
        kill: mock(),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      await tryDelegateToLocalCli();

      const spawnCall = mockSpawn.mock.calls[0];
      const spawnOptions = spawnCall[2];
      const env = spawnOptions.env;

      expect(env.FORCE_COLOR).toBe('1');
      expect(env.NODE_PATH).toContain('/test/project/node_modules');
      expect(env.PATH).toContain('/test/project/node_modules/.bin');
    });

    it('should preserve existing NODE_PATH and PATH', async () => {
      process.env.NODE_PATH = '/existing/node/path';
      process.env.PATH = '/existing/bin/path';
      process.argv = ['node', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      // Mock successful spawn
      const mockChildProcess = {
        on: mock((event: string, handler: Function) => {
          if (event === 'exit') {
            setTimeout(() => handler(0, null), 10);
          }
        }),
        kill: mock(),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      await tryDelegateToLocalCli();

      const spawnCall = mockSpawn.mock.calls[0];
      const spawnOptions = spawnCall[2];
      const env = spawnOptions.env;

      expect(env.NODE_PATH).toContain('/test/project/node_modules');
      expect(env.NODE_PATH).toContain('/existing/node/path');
      expect(env.PATH).toContain('/test/project/node_modules/.bin');
      expect(env.PATH).toContain('/existing/bin/path');
    });
  });

  describe('Error Handling', () => {
    it('should handle spawn errors gracefully', async () => {
      process.argv = ['node', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      const testError = new Error('Spawn failed');
      mockSpawn.mockImplementation(() => {
        throw testError;
      });

      const result = await tryDelegateToLocalCli();

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error during local CLI delegation:',
        testError
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Falling back to global CLI installation');
    });

    it('should handle process errors', async () => {
      process.argv = ['node', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      const testError = new Error('Process error');
      const mockChildProcess = {
        on: mock((event: string, handler: Function) => {
          if (event === 'error') {
            setTimeout(() => handler(testError), 10);
          }
        }),
        kill: mock(),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      try {
        await tryDelegateToLocalCli();
      } catch (error) {
        expect(error).toBe(testError);
      }

      expect(mockLogger.error).toHaveBeenCalledWith('Failed to start local CLI: Process error');
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
      process.argv = ['node', '/test/project/node_modules/@elizaos/cli/dist/index.js', 'start'];
      mockExistsSync.mockReturnValue(true);

      const context = getCliContext();

      expect(context.isLocal).toBe(true);
      expect(context.hasLocal).toBe(true);
      expect(context.localPath).toBe('/test/project/node_modules/@elizaos/cli/dist/index.js');
      expect(context.currentPath).toBe('/test/project/node_modules/@elizaos/cli/dist/index.js');
    });

    it('getCliContext should return correct context when not running from local CLI', () => {
      process.argv = ['node', '/usr/bin/elizaos', 'start'];
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
      process.argv = ['node', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      const mockChildProcess = {
        on: mock((event: string, handler: Function) => {
          if (event === 'exit') {
            setTimeout(() => handler(42, null), 10);
          }
        }),
        kill: mock(),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      await tryDelegateToLocalCli();

      expect(mockProcess.exit).toHaveBeenCalledWith(42);
    });

    it('should exit with appropriate code when killed by signal', async () => {
      process.argv = ['node', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      const mockChildProcess = {
        on: mock((event: string, handler: Function) => {
          if (event === 'exit') {
            setTimeout(() => handler(null, 'SIGTERM'), 10);
          }
        }),
        kill: mock(),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      await tryDelegateToLocalCli();

      expect(mockProcess.exit).toHaveBeenCalledWith(143);
    });

    it('should exit with 130 for SIGINT', async () => {
      process.argv = ['node', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      const mockChildProcess = {
        on: mock((event: string, handler: Function) => {
          if (event === 'exit') {
            setTimeout(() => handler(null, 'SIGINT'), 10);
          }
        }),
        kill: mock(),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      await tryDelegateToLocalCli();

      expect(mockProcess.exit).toHaveBeenCalledWith(130);
    });

    it('should exit with 1 for unknown signal', async () => {
      process.argv = ['node', '/usr/bin/elizaos', 'start'];
      mockExistsSync.mockReturnValue(true);

      const mockChildProcess = {
        on: mock((event: string, handler: Function) => {
          if (event === 'exit') {
            setTimeout(() => handler(null, 'SIGUSR1'), 10);
          }
        }),
        kill: mock(),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      await tryDelegateToLocalCli();

      expect(mockProcess.exit).toHaveBeenCalledWith(1);
    });
  });
});
