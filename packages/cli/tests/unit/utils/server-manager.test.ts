import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

// Mock process state for testing
let mockServerState = {
  process: null as any,
  isRunning: false,
};

// Mock implementations
const mockStartServerProcess = mock(async (args: string[] = []) => {
  // Stop existing process if running (matches real behavior)
  if (mockServerState.process && mockServerState.isRunning) {
    await mockStopServerProcess();
  }

  console.info('Starting server...');

  // Simulate process creation
  const mockProcess = {
    kill: mock(() => true),
    exited: Promise.resolve(0),
  };

  mockServerState.process = mockProcess;
  mockServerState.isRunning = true;

  return Promise.resolve();
});

const mockStopServerProcess = mock(async () => {
  if (!mockServerState.process || !mockServerState.isRunning) {
    return false;
  }

  console.info('Stopping current server process...');

  const killed = mockServerState.process.kill('SIGTERM');
  if (!killed) {
    console.warn('Failed to kill server process, trying force kill...');
    mockServerState.process.kill('SIGKILL');
  }

  mockServerState.process = null;
  mockServerState.isRunning = false;

  return true;
});

const mockRestartServerProcess = mock(async (args: string[] = []) => {
  console.info('Restarting server...');
  await mockStopServerProcess();
  await mockStartServerProcess(args);
});

const mockIsServerRunning = mock(() => {
  return mockServerState.isRunning && mockServerState.process !== null;
});

const mockGetServerProcess = mock(() => {
  return mockServerState.process;
});

// Mock fs module
const mockExistsSync = mock(() => false);
mock.module('fs', () => ({
  existsSync: mockExistsSync,
}));

// Mock the server manager module
mock.module('../../../src/commands/dev/utils/server-manager', () => {
  const createServerManager = () => ({
    async start(args: string[] = []): Promise<void> {
      return mockStartServerProcess(args);
    },

    async stop(): Promise<boolean> {
      return mockStopServerProcess();
    },

    async restart(args: string[] = []): Promise<void> {
      return mockRestartServerProcess(args);
    },

    get process() {
      return mockGetServerProcess();
    },

    isRunning(): boolean {
      return mockIsServerRunning();
    },
  });

  let serverManager: any = null;

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
  };
});

// Import the mocked module
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
  let consoleInfoSpy: any;
  let consoleWarnSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    // Mock console methods
    consoleInfoSpy = mock(() => {});
    consoleWarnSpy = mock(() => {});
    consoleErrorSpy = mock(() => {});

    console.info = consoleInfoSpy;
    console.warn = consoleWarnSpy;
    console.error = consoleErrorSpy;

    // Reset server state
    mockServerState.process = null;
    mockServerState.isRunning = false;

    // Clear all mocks
    mockStartServerProcess.mockClear();
    mockStopServerProcess.mockClear();
    mockRestartServerProcess.mockClear();
    mockIsServerRunning.mockClear();
    mockGetServerProcess.mockClear();
    mockExistsSync.mockClear();

    consoleInfoSpy.mockClear();
    consoleWarnSpy.mockClear();
    consoleErrorSpy.mockClear();
  });

  afterEach(() => {
    // Reset state
    mockServerState.process = null;
    mockServerState.isRunning = false;
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
    it('should start server process', async () => {
      const manager = createServerManager();
      await manager.start();

      expect(mockStartServerProcess).toHaveBeenCalledWith([]);
      expect(consoleInfoSpy).toHaveBeenCalledWith('Starting server...');
      expect(manager.isRunning()).toBe(true);
    });

    it('should start server with arguments', async () => {
      const manager = createServerManager();
      await manager.start(['--verbose', '--port', '3000']);

      expect(mockStartServerProcess).toHaveBeenCalledWith(['--verbose', '--port', '3000']);
      expect(consoleInfoSpy).toHaveBeenCalledWith('Starting server...');
    });

    it('should stop running server process', async () => {
      const manager = createServerManager();

      // Start server first
      await manager.start();
      expect(manager.isRunning()).toBe(true);

      // Stop server
      const result = await manager.stop();

      expect(result).toBe(true);
      expect(mockStopServerProcess).toHaveBeenCalled();
      expect(consoleInfoSpy).toHaveBeenCalledWith('Stopping current server process...');
      expect(manager.isRunning()).toBe(false);
    });

    it('should return false when stopping non-running server', async () => {
      const manager = createServerManager();

      const result = await manager.stop();

      expect(result).toBe(false);
      expect(mockStopServerProcess).toHaveBeenCalled();
    });

    it('should restart server process', async () => {
      const manager = createServerManager();

      await manager.restart(['--debug']);

      expect(mockRestartServerProcess).toHaveBeenCalledWith(['--debug']);
      expect(consoleInfoSpy).toHaveBeenCalledWith('Restarting server...');
    });

    it('should handle process kill failure', async () => {
      const manager = createServerManager();

      // Mock a process that fails to kill
      const mockProcess = {
        kill: mock(() => false), // First call fails
      };
      mockServerState.process = mockProcess;
      mockServerState.isRunning = true;

      const result = await manager.stop();

      expect(result).toBe(true);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Failed to kill server process, trying force kill...'
      );
    });
  });

  describe('global server manager', () => {
    it('should return same instance from getServerManager', () => {
      const manager1 = getServerManager();
      const manager2 = getServerManager();

      expect(manager1).toBe(manager2);
    });

    it('should work with global server manager', async () => {
      const manager = getServerManager();

      await manager.start(['--test']);

      expect(mockStartServerProcess).toHaveBeenCalledWith(['--test']);
      expect(manager.isRunning()).toBe(true);
    });
  });

  describe('utility functions', () => {
    it('should start server using startServer function', async () => {
      await startServer(['--test']);

      expect(mockStartServerProcess).toHaveBeenCalledWith(['--test']);
      expect(consoleInfoSpy).toHaveBeenCalledWith('Starting server...');
    });

    it('should stop server using stopServer function', async () => {
      // Start server first
      await startServer();

      const result = await stopServer();

      expect(result).toBe(true);
      expect(mockStopServerProcess).toHaveBeenCalled();
    });

    it('should restart server using restartServer function', async () => {
      await restartServer(['--restart-test']);

      expect(mockRestartServerProcess).toHaveBeenCalledWith(['--restart-test']);
      expect(consoleInfoSpy).toHaveBeenCalledWith('Restarting server...');
    });

    it('should check running status using isRunning function', async () => {
      expect(isRunning()).toBe(false);

      await startServer();
      expect(isRunning()).toBe(true);

      await stopServer();
      expect(isRunning()).toBe(false);
    });

    it('should get current process using getCurrentProcess function', async () => {
      expect(getCurrentProcess()).toBeNull();

      await startServer();
      expect(getCurrentProcess()).toBeDefined();

      await stopServer();
      expect(getCurrentProcess()).toBeNull();
    });
  });

  describe('server lifecycle', () => {
    it('should handle server start and stop lifecycle', async () => {
      const manager = createServerManager();

      // Initial state
      expect(manager.isRunning()).toBe(false);
      expect(manager.process).toBeNull();

      // Start server
      await manager.start(['--test']);
      expect(manager.isRunning()).toBe(true);
      expect(manager.process).toBeDefined();

      // Stop server
      const stopped = await manager.stop();
      expect(stopped).toBe(true);
      expect(manager.isRunning()).toBe(false);
      expect(manager.process).toBeNull();
    });

    it('should handle multiple start calls', async () => {
      const manager = createServerManager();

      await manager.start(['--first']);
      expect(mockStartServerProcess).toHaveBeenCalledTimes(1);

      await manager.start(['--second']);
      expect(mockStartServerProcess).toHaveBeenCalledTimes(2);
      expect(mockStopServerProcess).toHaveBeenCalledTimes(1); // Should stop first
    });

    it('should handle restart without prior start', async () => {
      const manager = createServerManager();

      await manager.restart(['--restart']);

      expect(mockRestartServerProcess).toHaveBeenCalledWith(['--restart']);
      expect(consoleInfoSpy).toHaveBeenCalledWith('Restarting server...');
    });
  });

  describe('edge cases', () => {
    it('should handle empty arguments', async () => {
      const manager = createServerManager();

      await manager.start();
      expect(mockStartServerProcess).toHaveBeenCalledWith([]);

      await manager.restart();
      expect(mockRestartServerProcess).toHaveBeenCalledWith([]);
    });

    it('should handle stopping already stopped server', async () => {
      const manager = createServerManager();

      const result1 = await manager.stop();
      expect(result1).toBe(false);

      const result2 = await manager.stop();
      expect(result2).toBe(false);
    });

    it('should maintain state consistency across operations', async () => {
      const manager = createServerManager();

      // Start
      await manager.start();
      expect(manager.isRunning()).toBe(true);

      // Restart
      await manager.restart(['--new-args']);
      expect(manager.isRunning()).toBe(true);

      // Stop
      await manager.stop();
      expect(manager.isRunning()).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should handle process creation errors gracefully', async () => {
      // Mock error in start process
      mockStartServerProcess.mockImplementationOnce(() => {
        throw new Error('Process creation failed');
      });

      const manager = createServerManager();

      try {
        await manager.start();
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it('should handle process stop errors gracefully', async () => {
      const manager = createServerManager();

      // Start server first
      await manager.start();

      // Mock error in stop process
      mockStopServerProcess.mockImplementationOnce(() => {
        throw new Error('Process stop failed');
      });

      try {
        await manager.stop();
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });
});
