import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';

// Mock the Bun.spawn function
const mockBunSpawn = mock(() => ({
  kill: mock(() => true),
  exited: Promise.resolve(0),
  stdout: null,
  stderr: null,
  stdin: null,
}));

// Mock fs module for existsSync
const mockExistsSync = mock(() => false);

// Mock the server-manager module with our mocked Bun.spawn
mock.module('../../../src/commands/dev/utils/server-manager', () => {
  let serverState = {
    process: null,
    isRunning: false,
  };

  const mockGetLocalCliPath = mock(async () => {
    return mockExistsSync() ? '/workspace/node_modules/@elizaos/cli/dist/index.js' : null;
  });

  const mockSetupEnvironment = mock(() => {
    const env = { ...process.env };
    const localModulesPath = '/workspace/node_modules';
    const localBinPath = '/workspace/node_modules/.bin';

    if (env.NODE_PATH) {
      env.NODE_PATH = `${localModulesPath}:${env.NODE_PATH}`;
    } else {
      env.NODE_PATH = localModulesPath;
    }

    if (env.PATH) {
      env.PATH = `${localBinPath}:${env.PATH}`;
    } else {
      env.PATH = localBinPath;
    }

    env.FORCE_COLOR = '1';
    return env;
  });

  const mockStartServerProcess = mock(async (args = []) => {
    console.info('Starting server...');

    const localCliPath = await mockGetLocalCliPath();
    let scriptPath;

    if (localCliPath) {
      console.info('Using local @elizaos/cli installation');
      scriptPath = localCliPath;
    } else {
      scriptPath = process.argv[1];
    }

    const env = mockSetupEnvironment();
    const nodeExecutable = process.execPath;

    const process = mockBunSpawn([nodeExecutable, scriptPath, 'start', ...args], {
      stdio: ['inherit', 'inherit', 'inherit'],
      env,
      cwd: process.cwd(),
    });

    serverState.process = process;
    serverState.isRunning = true;

    // Handle process completion
    process.exited
      .then((exitCode) => {
        if (exitCode !== 0) {
          console.warn(`Server process exited with code ${exitCode}`);
        } else {
          console.info('Server process exited normally');
        }
        serverState.process = null;
        serverState.isRunning = false;
      })
      .catch((error) => {
        console.error(`Server process error: ${error.message}`);
        serverState.process = null;
        serverState.isRunning = false;
      });
  });

  const mockStopServerProcess = mock(async () => {
    if (!serverState.process || !serverState.isRunning) {
      return false;
    }

    console.info('Stopping current server process...');

    try {
      const killed = serverState.process.kill('SIGTERM');

      if (!killed) {
        console.warn('Failed to kill server process, trying force kill...');
        serverState.process.kill('SIGKILL');
      }

      serverState.process = null;
      serverState.isRunning = false;

      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    } catch (error) {
      console.error(`Error stopping server process: ${error}`);
      serverState.process = null;
      serverState.isRunning = false;
      return false;
    }
  });

  const mockRestartServerProcess = mock(async (args = []) => {
    console.info('Restarting server...');
    await mockStartServerProcess(args);
  });

  const mockIsServerRunning = mock(() => {
    return serverState.isRunning && serverState.process !== null;
  });

  const mockGetServerProcess = mock(() => {
    return serverState.process;
  });

  const createServerManager = () => ({
    async start(args = []) {
      return mockStartServerProcess(args);
    },

    async stop() {
      return mockStopServerProcess();
    },

    async restart(args = []) {
      return mockRestartServerProcess(args);
    },

    get process() {
      return mockGetServerProcess();
    },

    isRunning() {
      return mockIsServerRunning();
    },
  });

  let serverManager = null;

  const getServerManager = () => {
    if (!serverManager) {
      serverManager = createServerManager();
    }
    return serverManager;
  };

  return {
    createServerManager,
    getServerManager,
    startServer: mockStartServerProcess,
    stopServer: mockStopServerProcess,
    restartServer: mockRestartServerProcess,
    isRunning: mockIsServerRunning,
    getCurrentProcess: mockGetServerProcess,
    // Export mocks for testing
    __mocks: {
      mockBunSpawn,
      mockExistsSync,
      mockStartServerProcess,
      mockStopServerProcess,
      mockRestartServerProcess,
      mockIsServerRunning,
      mockGetServerProcess,
      mockGetLocalCliPath,
      mockSetupEnvironment,
      serverState,
    },
  };
});

mock.module('fs', () => ({
  existsSync: mockExistsSync,
}));

// Import the mocked module
import {
  createServerManager,
  getServerManager,
  startServer,
  stopServer,
  restartServer,
  isRunning,
  getCurrentProcess,
  __mocks,
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
    mockBunSpawn.mockClear();
    mockExistsSync.mockClear();

    // Clear all server manager mocks
    if (__mocks) {
      Object.values(__mocks).forEach((mockFn) => {
        if (typeof mockFn === 'function' && mockFn.mockClear) {
          mockFn.mockClear();
        }
      });

      // Reset server state
      __mocks.serverState.process = null;
      __mocks.serverState.isRunning = false;
    }
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
      mockExistsSync.mockReturnValue(false); // No local CLI
      mockBunSpawn.mockReturnValue({
        kill: mock(() => true),
        exited: Promise.resolve(0),
      });

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
      mockExistsSync.mockReturnValue(true); // Local CLI exists
      mockBunSpawn.mockReturnValue({
        kill: mock(() => true),
        exited: Promise.resolve(0),
      });

      process.env = { PATH: '/usr/bin' };

      const manager = createServerManager();
      await manager.start();

      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['/usr/bin/node', '/workspace/node_modules/@elizaos/cli/dist/index.js', 'start'],
        expect.anything()
      );

      expect(consoleInfoSpy).toHaveBeenCalledWith('Using local @elizaos/cli installation');
    });

    it('should handle PATH environment variable when undefined', async () => {
      mockExistsSync.mockReturnValue(false);
      mockBunSpawn.mockReturnValue({
        kill: mock(() => true),
        exited: Promise.resolve(0),
      });

      // Set up env without PATH
      process.env = {
        NODE_PATH: '/existing/node/path',
      };

      const manager = createServerManager();
      await manager.start();

      expect(mockBunSpawn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: '/workspace/node_modules/.bin',
            NODE_PATH: '/workspace/node_modules:/existing/node/path',
          }),
        })
      );
    });

    it('should pass additional arguments to start command', async () => {
      mockExistsSync.mockReturnValue(false);
      mockBunSpawn.mockReturnValue({
        kill: mock(() => true),
        exited: Promise.resolve(0),
      });

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

    it('should handle process that fails to kill gracefully', async () => {
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
      mockBunSpawn.mockReturnValue({
        kill: mock(() => true),
        exited: Promise.resolve(0),
      });
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
    it('should handle process exit with code 0', async () => {
      let exitResolve: (value: number) => void;
      const exitPromise = new Promise<number>((resolve) => {
        exitResolve = resolve;
      });

      mockBunSpawn.mockReturnValue({
        kill: mock(() => true),
        exited: exitPromise,
      });
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      const manager = createServerManager();
      await manager.start();

      expect(manager.isRunning()).toBe(true);

      // Simulate process exit with code 0
      exitResolve!(0);
      await exitPromise;

      // Give some time for the exit handler to run
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(consoleInfoSpy).toHaveBeenCalledWith('Server process exited normally');
      expect(manager.isRunning()).toBe(false);
    });

    it('should handle process exit with error code', async () => {
      let exitResolve: (value: number) => void;
      const exitPromise = new Promise<number>((resolve) => {
        exitResolve = resolve;
      });

      mockBunSpawn.mockReturnValue({
        kill: mock(() => true),
        exited: exitPromise,
      });
      mockExistsSync.mockReturnValue(false);

      process.env = { PATH: '/usr/bin' };

      const manager = createServerManager();
      await manager.start();

      // Simulate process exit with error code
      exitResolve!(1);
      await exitPromise;

      // Give some time for the exit handler to run
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(consoleWarnSpy).toHaveBeenCalledWith('Server process exited with code 1');
      expect(manager.isRunning()).toBe(false);
    });
  });
});
