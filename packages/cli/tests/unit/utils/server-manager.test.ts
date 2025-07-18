import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { DevServerManager } from '../../../src/commands/dev/utils/server-manager';

// Mock the child_process spawn function
const mockSpawn = mock(() => ({
  on: mock(),
  kill: mock(() => true),
  killed: false,
}));

// Mock node:child_process module
mock.module('node:child_process', () => ({
  spawn: mockSpawn,
}));

// Mock fs module for existsSync
const mockExistsSync = mock(() => false);
mock.module('fs', () => ({
  existsSync: mockExistsSync,
}));

describe('DevServerManager', () => {
  let originalExecPath: string;
  let originalArgv: string[];
  let originalCwd: () => string;
  let originalEnv: NodeJS.ProcessEnv;
  let consoleInfoSpy: any;
  let consoleWarnSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    // Store original process values
    originalExecPath = process.execPath;
    originalArgv = [...process.argv];
    originalCwd = process.cwd;
    originalEnv = { ...process.env };

    // Mock process values
    process.execPath = '/usr/bin/node';
    process.argv = ['/usr/bin/node', '/path/to/script.js'];

    // Mock process.cwd
    const mockCwd = mock(() => '/workspace');
    process.cwd = mockCwd;

    // Mock console methods
    consoleInfoSpy = spyOn(console, 'info').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    // Clear mock calls
    mockSpawn.mockClear();
    mockExistsSync.mockClear();
  });

  afterEach(() => {
    // Restore original process values
    process.execPath = originalExecPath;
    process.argv = originalArgv;
    process.cwd = originalCwd;
    process.env = originalEnv;

    // Restore console methods
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('start()', () => {
    it('should handle PATH environment variable correctly when PATH exists', async () => {
      const mockChildProcess = {
        on: mock(),
        kill: mock(() => true),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);
      mockExistsSync.mockReturnValue(false); // No local CLI

      // Set up env with both PATH and NODE_PATH
      process.env = {
        NODE_PATH: '/existing/node/path',
        PATH: '/usr/bin:/usr/local/bin',
      };

      const manager = new DevServerManager();
      await manager.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/node',
        ['/path/to/script.js', 'start'],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: expect.stringContaining('/workspace/node_modules/.bin'),
            NODE_PATH: expect.stringContaining('/workspace/node_modules'),
          }),
        })
      );

      const spawnCall = mockSpawn.mock.calls[0];
      const env = spawnCall[2].env;

      // Verify PATH is constructed correctly
      expect(env.PATH).toBe('/workspace/node_modules/.bin:/usr/bin:/usr/local/bin');
      expect(env.NODE_PATH).toBe('/workspace/node_modules:/existing/node/path');
    });

    it('should handle PATH environment variable correctly when PATH is undefined', async () => {
      const mockChildProcess = {
        on: mock(),
        kill: mock(() => true),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);
      mockExistsSync.mockReturnValue(false); // No local CLI

      // Set up env without PATH
      process.env = {
        NODE_PATH: '/existing/node/path',
      };

      const manager = new DevServerManager();
      await manager.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/node',
        ['/path/to/script.js', 'start'],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: '/workspace/node_modules/.bin',
            NODE_PATH: expect.stringContaining('/workspace/node_modules'),
          }),
        })
      );

      const spawnCall = mockSpawn.mock.calls[0];
      const env = spawnCall[2].env;

      // Verify PATH is set to just the local bin path when original PATH was undefined
      expect(env.PATH).toBe('/workspace/node_modules/.bin');
      expect(env.NODE_PATH).toBe('/workspace/node_modules:/existing/node/path');
    });

    it('should handle NODE_PATH environment variable correctly when NODE_PATH is undefined', async () => {
      const mockChildProcess = {
        on: mock(),
        kill: mock(() => true),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);
      mockExistsSync.mockReturnValue(false); // No local CLI

      // Set up env without NODE_PATH
      process.env = {
        PATH: '/usr/bin:/usr/local/bin',
      };

      const manager = new DevServerManager();
      await manager.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/node',
        ['/path/to/script.js', 'start'],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: expect.stringContaining('/workspace/node_modules/.bin'),
            NODE_PATH: '/workspace/node_modules',
          }),
        })
      );

      const spawnCall = mockSpawn.mock.calls[0];
      const env = spawnCall[2].env;

      // Verify NODE_PATH is set to just the local modules path when original NODE_PATH was undefined
      expect(env.NODE_PATH).toBe('/workspace/node_modules');
      expect(env.PATH).toBe('/workspace/node_modules/.bin:/usr/bin:/usr/local/bin');
    });

    it('should handle both PATH and NODE_PATH being undefined', async () => {
      const mockChildProcess = {
        on: mock(),
        kill: mock(() => true),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);
      mockExistsSync.mockReturnValue(false); // No local CLI

      // Set up env without PATH and NODE_PATH
      process.env = {};

      const manager = new DevServerManager();
      await manager.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/node',
        ['/path/to/script.js', 'start'],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: '/workspace/node_modules/.bin',
            NODE_PATH: '/workspace/node_modules',
          }),
        })
      );

      const spawnCall = mockSpawn.mock.calls[0];
      const env = spawnCall[2].env;

      // Verify both are set to their respective local paths
      expect(env.PATH).toBe('/workspace/node_modules/.bin');
      expect(env.NODE_PATH).toBe('/workspace/node_modules');
    });

    it('should use local CLI when available', async () => {
      const mockChildProcess = {
        on: mock(),
        kill: mock(() => true),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);
      mockExistsSync.mockReturnValue(true); // Local CLI exists

      process.env = {
        PATH: '/usr/bin:/usr/local/bin',
      };

      const manager = new DevServerManager();
      await manager.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/node',
        ['/workspace/node_modules/@elizaos/cli/dist/index.js', 'start'],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: expect.stringContaining('/workspace/node_modules/.bin'),
            NODE_PATH: '/workspace/node_modules',
          }),
        })
      );

      expect(consoleInfoSpy).toHaveBeenCalledWith('Using local @elizaos/cli installation');
    });

    it('should pass additional arguments to start command', async () => {
      const mockChildProcess = {
        on: mock(),
        kill: mock(() => true),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      const manager = new DevServerManager();
      await manager.start(['--verbose', '--port', '3000']);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/node',
        ['/path/to/script.js', 'start', '--verbose', '--port', '3000'],
        expect.anything()
      );
    });

    it('should set up process event handlers', async () => {
      const mockChildProcess = {
        on: mock(),
        kill: mock(() => true),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      const manager = new DevServerManager();
      await manager.start();

      // Verify event handlers were set up
      expect(mockChildProcess.on).toHaveBeenCalledWith('exit', expect.any(Function));
      expect(mockChildProcess.on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('stop()', () => {
    it('should stop the running process', async () => {
      const mockChildProcess = {
        on: mock(),
        kill: mock(() => true),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);
      mockExistsSync.mockReturnValue(false);

      // Set minimal env for test
      process.env = {
        PATH: '/usr/bin:/usr/local/bin',
        NODE_PATH: '/existing/node/path',
      };

      const manager = new DevServerManager();
      await manager.start();

      const result = await manager.stop();

      expect(result).toBe(true);
      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(manager.process).toBeNull();
    });

    it('should return false when no process is running', async () => {
      const manager = new DevServerManager();
      const result = await manager.stop();

      expect(result).toBe(false);
    });

    it('should handle process that fails to kill gracefully', async () => {
      const mockChildProcess = {
        on: mock(),
        kill: mock(() => false), // Simulate failed kill
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      const manager = new DevServerManager();
      await manager.start();

      const result = await manager.stop();

      expect(result).toBe(true);
      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGKILL');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Failed to kill server process, trying force kill...'
      );
    });
  });

  describe('restart()', () => {
    it('should restart the server process', async () => {
      const mockChildProcess = {
        on: mock(),
        kill: mock(() => true),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      const manager = new DevServerManager();
      await manager.start();

      // Clear spawn calls from start
      mockSpawn.mockClear();

      await manager.restart(['--debug']);

      // Should have been called again for restart
      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/node',
        ['/path/to/script.js', 'start', '--debug'],
        expect.anything()
      );
    });
  });

  describe('process event handling', () => {
    it('should handle process exit event', async () => {
      const mockChildProcess = {
        on: mock(),
        kill: mock(() => true),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      const manager = new DevServerManager();
      await manager.start();

      // Simulate process exit
      const exitHandler = mockChildProcess.on.mock.calls.find((call) => call[0] === 'exit')?.[1];
      expect(exitHandler).toBeDefined();

      // Test normal exit
      exitHandler(0, null);
      expect(consoleInfoSpy).toHaveBeenCalledWith('Server process exited normally');
      expect(manager.process).toBeNull();

      // Reset for next test
      await manager.start();
      mockSpawn.mockClear();

      // Test error exit
      exitHandler(1, null);
      expect(consoleWarnSpy).toHaveBeenCalledWith('Server process exited with code 1');
    });

    it('should handle process error event', async () => {
      const mockChildProcess = {
        on: mock(),
        kill: mock(() => true),
        killed: false,
      };
      mockSpawn.mockReturnValue(mockChildProcess);
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      const manager = new DevServerManager();
      await manager.start();

      // Simulate process error
      const errorHandler = mockChildProcess.on.mock.calls.find((call) => call[0] === 'error')?.[1];
      expect(errorHandler).toBeDefined();

      const testError = new Error('Test error');
      errorHandler(testError);

      expect(consoleErrorSpy).toHaveBeenCalledWith('Server process error: Test error');
      expect(manager.process).toBeNull();
    });
  });
});
