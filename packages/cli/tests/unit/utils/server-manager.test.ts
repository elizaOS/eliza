import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';

// Mock Bun.spawn
const mockBunSpawn = mock(() => ({
  kill: mock(() => true),
  exited: Promise.resolve(0),
  stdout: null,
  stderr: null,
  stdin: null,
}));

// Mock fs.existsSync
const mockExistsSync = mock(() => false);

// Mock the bun-exec module
mock.module('../../../src/utils/bun-exec', () => ({
  bunExecInherit: mock(() =>
    Promise.resolve({ stdout: '', stderr: '', exitCode: 0, success: true })
  ),
}));

// Mock fs module
mock.module('fs', () => ({
  existsSync: mockExistsSync,
}));

// Mock Bun global
const originalBun = global.Bun;
beforeEach(() => {
  (global as any).Bun = {
    spawn: mockBunSpawn,
  };
});

afterEach(() => {
  (global as any).Bun = originalBun;
});

// Import the server manager functions
import {
  createServerManager,
  getServerManager,
  startServer,
  stopServer,
  restartServer,
  isRunning,
  getCurrentProcess,
} from '../../../src/commands/dev/utils/server-manager';

describe('Server Manager (Functional)', () => {
  let originalExecPath: string;
  let originalArgv: string[];
  let originalCwd: () => string;
  let originalEnv: NodeJS.ProcessEnv;
  let consoleInfoSpy: any;
  let consoleWarnSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    // Store original values
    originalExecPath = process.execPath;
    originalArgv = [...process.argv];
    originalCwd = process.cwd;
    originalEnv = { ...process.env };

    // Mock process values
    process.execPath = '/usr/bin/node';
    process.argv = ['/usr/bin/node', '/path/to/script.js'];
    process.cwd = mock(() => '/workspace');

    // Mock console methods
    consoleInfoSpy = spyOn(console, 'info').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    // Clear all mocks
    mockBunSpawn.mockClear();
    mockExistsSync.mockClear();
  });

  afterEach(() => {
    // Restore original values
    process.execPath = originalExecPath;
    process.argv = originalArgv;
    process.cwd = originalCwd;
    process.env = originalEnv;

    // Restore console spies
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('createServerManager', () => {
    it('should create a server manager with functional interface', () => {
      const manager = createServerManager();

      expect(manager).toBeDefined();
      expect(typeof manager.start).toBe('function');
      expect(typeof manager.stop).toBe('function');
      expect(typeof manager.restart).toBe('function');
      expect(typeof manager.isRunning).toBe('function');
      expect(manager.process).toBeNull();
    });

    it('should return false for isRunning when no process is active', () => {
      const manager = createServerManager();
      expect(manager.isRunning()).toBe(false);
    });
  });

  describe('server process management', () => {
    it('should start server with correct environment setup', async () => {
      const mockProcess = {
        kill: mock(() => true),
        exited: Promise.resolve(0),
      };
      mockBunSpawn.mockReturnValue(mockProcess);
      mockExistsSync.mockReturnValue(false); // No local CLI

      // Set up env with both PATH and NODE_PATH
      process.env = {
        NODE_PATH: '/existing/node/path',
        PATH: '/usr/bin:/usr/local/bin',
      };

      const manager = createServerManager();
      await manager.start();

      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['/usr/bin/node', '/path/to/script.js', 'start'],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: '/workspace/node_modules/.bin:/usr/bin:/usr/local/bin',
            NODE_PATH: '/workspace/node_modules:/existing/node/path',
            FORCE_COLOR: '1',
          }),
          cwd: '/workspace',
          stdio: ['inherit', 'inherit', 'inherit'],
        })
      );

      expect(consoleInfoSpy).toHaveBeenCalledWith('Starting server...');
    });

    it('should use local CLI when available', async () => {
      const mockProcess = {
        kill: mock(() => true),
        exited: Promise.resolve(0),
      };
      mockBunSpawn.mockReturnValue(mockProcess);
      mockExistsSync.mockReturnValue(true); // Local CLI exists

      process.env = { PATH: '/usr/bin' };

      const manager = createServerManager();
      await manager.start();

      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['/usr/bin/node', '/workspace/node_modules/@elizaos/cli/dist/index.js', 'start'],
        expect.anything()
      );

      expect(consoleInfoSpy).toHaveBeenCalledWith('Using local @elizaos/cli installation');
    });

    it('should handle environment variables correctly', async () => {
      const mockProcess = {
        kill: mock(() => true),
        exited: Promise.resolve(0),
      };
      mockBunSpawn.mockReturnValue(mockProcess);
      mockExistsSync.mockReturnValue(false);

      // Test with minimal env
      process.env = {};

      const manager = createServerManager();
      await manager.start();

      expect(mockBunSpawn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: '/workspace/node_modules/.bin',
            NODE_PATH: '/workspace/node_modules',
            FORCE_COLOR: '1',
          }),
        })
      );
    });

    it('should pass additional arguments to start command', async () => {
      const mockProcess = {
        kill: mock(() => true),
        exited: Promise.resolve(0),
      };
      mockBunSpawn.mockReturnValue(mockProcess);
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      const manager = createServerManager();
      await manager.start(['--verbose', '--port', '3000']);

      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['/usr/bin/node', '/path/to/script.js', 'start', '--verbose', '--port', '3000'],
        expect.anything()
      );
    });
  });

  describe('stop functionality', () => {
    it('should stop the running process', async () => {
      const mockProcess = {
        kill: mock(() => true),
        exited: Promise.resolve(0),
      };
      mockBunSpawn.mockReturnValue(mockProcess);
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      const manager = createServerManager();
      await manager.start();

      const result = await manager.stop();

      expect(result).toBe(true);
      expect(consoleInfoSpy).toHaveBeenCalledWith('Stopping current server process...');
    });

    it('should return false when no process is running', async () => {
      const manager = createServerManager();
      const result = await manager.stop();

      expect(result).toBe(false);
    });

    it('should handle process that fails to kill', async () => {
      const mockProcess = {
        kill: mock(() => false), // Simulate failed kill
        exited: Promise.resolve(0),
      };
      mockBunSpawn.mockReturnValue(mockProcess);
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      const manager = createServerManager();
      await manager.start();

      const result = await manager.stop();

      expect(result).toBe(true);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Failed to kill server process, trying force kill...'
      );
    });
  });

  describe('restart functionality', () => {
    it('should restart the server process', async () => {
      const mockProcess = {
        kill: mock(() => true),
        exited: Promise.resolve(0),
      };
      mockBunSpawn.mockReturnValue(mockProcess);
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      const manager = createServerManager();
      await manager.restart(['--debug']);

      expect(consoleInfoSpy).toHaveBeenCalledWith('Restarting server...');
      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['/usr/bin/node', '/path/to/script.js', 'start', '--debug'],
        expect.anything()
      );
    });
  });

  describe('global server manager', () => {
    it('should return same instance from getServerManager', () => {
      const manager1 = getServerManager();
      const manager2 = getServerManager();

      expect(manager1).toBe(manager2);
    });
  });

  describe('utility functions', () => {
    it('should start server using startServer function', async () => {
      mockBunSpawn.mockReturnValue({
        kill: mock(() => true),
        exited: Promise.resolve(0),
      });
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      await startServer(['--test']);

      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['/usr/bin/node', '/path/to/script.js', 'start', '--test'],
        expect.anything()
      );
    });

    it('should stop server using stopServer function', async () => {
      mockBunSpawn.mockReturnValue({
        kill: mock(() => true),
        exited: Promise.resolve(0),
      });
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      // Start server first
      await startServer();

      const result = await stopServer();

      expect(result).toBe(true);
    });

    it('should restart server using restartServer function', async () => {
      mockBunSpawn.mockReturnValue({
        kill: mock(() => true),
        exited: Promise.resolve(0),
      });
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      await restartServer(['--restart-test']);

      expect(consoleInfoSpy).toHaveBeenCalledWith('Restarting server...');
      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['/usr/bin/node', '/path/to/script.js', 'start', '--restart-test'],
        expect.anything()
      );
    });

    it('should check running status using isRunning function', () => {
      expect(isRunning()).toBe(false);
    });

    it('should get current process using getCurrentProcess function', () => {
      expect(getCurrentProcess()).toBeNull();
    });
  });

  describe('process lifecycle', () => {
    it('should handle process completion', async () => {
      let resolveExit: (code: number) => void;
      const exitPromise = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });

      const mockProcess = {
        kill: mock(() => true),
        exited: exitPromise,
      };
      mockBunSpawn.mockReturnValue(mockProcess);
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      const manager = createServerManager();
      await manager.start();

      expect(manager.isRunning()).toBe(true);

      // Simulate process exit
      resolveExit(0);
      await exitPromise;

      // Give some time for the exit handler to run
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(consoleInfoSpy).toHaveBeenCalledWith('Server process exited normally');
    });

    it('should handle process error exit', async () => {
      let resolveExit: (code: number) => void;
      const exitPromise = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });

      const mockProcess = {
        kill: mock(() => true),
        exited: exitPromise,
      };
      mockBunSpawn.mockReturnValue(mockProcess);
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      const manager = createServerManager();
      await manager.start();

      // Simulate process exit with error
      resolveExit(1);
      await exitPromise;

      // Give some time for the exit handler to run
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(consoleWarnSpy).toHaveBeenCalledWith('Server process exited with code 1');
    });
  });
});
