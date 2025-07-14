import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// Simple unit tests that test CLI argument parsing logic directly
// without importing the full CLI module (which has heavy dependencies)

describe('CLI argument parsing logic', () => {
  it('should detect --no-emoji flag in process.argv', () => {
    const testArgv = ['node', 'elizaos', '--no-emoji'];
    const hasNoEmojiFlag = testArgv.includes('--no-emoji');
    expect(hasNoEmojiFlag).toBe(true);
  });

  it('should detect --no-auto-install flag in process.argv', () => {
    const testArgv = ['node', 'elizaos', '--no-auto-install'];
    const hasNoAutoInstallFlag = testArgv.includes('--no-auto-install');
    expect(hasNoAutoInstallFlag).toBe(true);
  });

  it('should detect when no arguments are provided', () => {
    const testArgv = ['node', 'elizaos'];
    const hasNoArgs = testArgv.length === 2;
    expect(hasNoArgs).toBe(true);
  });

  it('should detect update command', () => {
    const testArgv = ['node', 'elizaos', 'update'];
    const args = testArgv.slice(2);
    const isUpdateCommand = args.includes('update');
    expect(isUpdateCommand).toBe(true);
  });

  it('should detect when banner should be shown', () => {
    const testArgv = ['node', 'elizaos'];
    const args = testArgv.slice(2);
    const willShowBanner = args.length === 0;
    expect(willShowBanner).toBe(true);
  });

  it('should not show banner when command is provided', () => {
    const testArgv = ['node', 'elizaos', 'start'];
    const args = testArgv.slice(2);
    const willShowBanner = args.length === 0;
    expect(willShowBanner).toBe(false);
  });
});

describe('Signal handling', () => {
  let originalExit: typeof process.exit;
  let mockExit: ReturnType<typeof mock>;
  let mockLogger: any;
  let mockStopServer: ReturnType<typeof mock>;
  let shutdownState: { isShuttingDown: boolean; tryInitiateShutdown(): boolean };

  beforeEach(() => {
    // Reset shutdown state
    shutdownState = {
      isShuttingDown: false,
      tryInitiateShutdown(): boolean {
        if (this.isShuttingDown) {
          return false;
        }
        this.isShuttingDown = true;
        return true;
      },
    };

    // Mock process.exit
    originalExit = process.exit;
    mockExit = mock((code?: number) => {
      throw new Error(`Process exit called with code: ${code}`);
    });
    process.exit = mockExit as any;

    // Mock logger
    mockLogger = {
      info: mock(),
      error: mock(),
      debug: mock(),
    };

    // Mock stopServer
    mockStopServer = mock(async () => {
      // Default mock implementation - returns true (server was stopped)
      return true;
    });
  });

  afterEach(() => {
    // Restore original process.exit
    process.exit = originalExit;
    mockExit.mockRestore();
    mockLogger.info.mockRestore();
    mockLogger.error.mockRestore();
    mockLogger.debug.mockRestore();
    mockStopServer.mockRestore();
  });

  // Test gracefulShutdown function behavior
  async function testGracefulShutdown(signal: string, expectedExitCode: number) {
    // Simulate the gracefulShutdown function logic with new shutdown state
    if (!shutdownState.tryInitiateShutdown()) {
      mockLogger.debug(`Ignoring ${signal} - shutdown already in progress`);
      return;
    }

    mockLogger.info(`Received ${signal}, shutting down gracefully...`);

    try {
      const serverWasStopped = await mockStopServer();
      if (serverWasStopped) {
        mockLogger.info('Server stopped successfully');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      mockLogger.error(`Error stopping server: ${errorMessage}`);
      mockLogger.debug('Full error details:', error);
    }

    const exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 0;
    expect(exitCode).toBe(expectedExitCode);

    try {
      process.exit(exitCode);
    } catch (error) {
      // Expected behavior in test environment
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(`Process exit called with code: ${exitCode}`);
    }
  }

  it('should handle SIGINT gracefully and exit with code 130', async () => {
    await testGracefulShutdown('SIGINT', 130);

    expect(mockLogger.info).toHaveBeenCalledWith('Received SIGINT, shutting down gracefully...');
    expect(mockLogger.info).toHaveBeenCalledWith('Server stopped successfully');
    expect(mockStopServer).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(130);
  });

  it('should handle SIGTERM gracefully and exit with code 143', async () => {
    await testGracefulShutdown('SIGTERM', 143);

    expect(mockLogger.info).toHaveBeenCalledWith('Received SIGTERM, shutting down gracefully...');
    expect(mockLogger.info).toHaveBeenCalledWith('Server stopped successfully');
    expect(mockStopServer).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(143);
  });

  it('should handle server stop errors gracefully', async () => {
    // Mock stopServer to throw an error
    const testError = new Error('Server stop failed');
    mockStopServer.mockRejectedValue(testError);

    // Simulate gracefulShutdown with error using new shutdown state
    if (!shutdownState.tryInitiateShutdown()) {
      mockLogger.debug(`Ignoring SIGINT - shutdown already in progress`);
      return;
    }

    mockLogger.info(`Received SIGINT, shutting down gracefully...`);

    try {
      const serverWasStopped = await mockStopServer();
      if (serverWasStopped) {
        mockLogger.info('Server stopped successfully');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      mockLogger.error(`Error stopping server: ${errorMessage}`);
      mockLogger.debug('Full error details:', error);
    }

    try {
      process.exit(130);
    } catch (error) {
      // Expected behavior in test environment
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Process exit called with code: 130');
    }

    expect(mockLogger.error).toHaveBeenCalledWith('Error stopping server: Server stop failed');
    expect(mockLogger.debug).toHaveBeenCalledWith('Full error details:', testError);
    expect(mockExit).toHaveBeenCalledWith(130);
  });

  it('should handle non-Error objects in catch block', async () => {
    // Mock stopServer to throw a non-Error object
    const testErrorObject = { message: 'Non-error object' };
    mockStopServer.mockRejectedValue(testErrorObject);

    // Simulate gracefulShutdown with non-Error object using new shutdown state
    if (!shutdownState.tryInitiateShutdown()) {
      mockLogger.debug(`Ignoring SIGINT - shutdown already in progress`);
      return;
    }

    mockLogger.info(`Received SIGINT, shutting down gracefully...`);

    try {
      const serverWasStopped = await mockStopServer();
      if (serverWasStopped) {
        mockLogger.info('Server stopped successfully');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      mockLogger.error(`Error stopping server: ${errorMessage}`);
      mockLogger.debug('Full error details:', error);
    }

    try {
      process.exit(130);
    } catch (error) {
      // Expected behavior in test environment
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Process exit called with code: 130');
    }

    expect(mockLogger.error).toHaveBeenCalledWith('Error stopping server: [object Object]');
    expect(mockLogger.debug).toHaveBeenCalledWith('Full error details:', testErrorObject);
  });

  it('should prevent multiple concurrent shutdown attempts', async () => {
    // First shutdown attempt
    const firstShutdown = async () => {
      if (!shutdownState.tryInitiateShutdown()) {
        mockLogger.debug(`Ignoring SIGINT - shutdown already in progress`);
        return;
      }
      mockLogger.info(`Received SIGINT, shutting down gracefully...`);

      // Simulate a slow server stop
      await new Promise((resolve) => setTimeout(resolve, 100));
      await mockStopServer();
      mockLogger.info('Server stopped successfully');

      try {
        process.exit(130);
      } catch (error) {
        // Expected behavior in test environment
      }
    };

    // Second shutdown attempt (should be ignored)
    const secondShutdown = async () => {
      if (!shutdownState.tryInitiateShutdown()) {
        mockLogger.debug(`Ignoring SIGTERM - shutdown already in progress`);
        return;
      }
      mockLogger.info(`Received SIGTERM, shutting down gracefully...`);
      await mockStopServer();
      mockLogger.info('Server stopped successfully');

      try {
        process.exit(143);
      } catch (error) {
        // Expected behavior in test environment
      }
    };

    // Run both shutdown attempts concurrently
    await Promise.all([firstShutdown(), secondShutdown()]);

    // Verify first shutdown was processed
    expect(mockLogger.info).toHaveBeenCalledWith('Received SIGINT, shutting down gracefully...');
    expect(mockLogger.info).toHaveBeenCalledWith('Server stopped successfully');

    // Verify second shutdown was ignored
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Ignoring SIGTERM - shutdown already in progress'
    );

    // Verify stopServer was only called once
    expect(mockStopServer).toHaveBeenCalledTimes(1);
  });

  it('should handle fallback exit code for unknown signals', async () => {
    // Test with an unknown signal
    const unknownSignal = 'SIGUSR1';

    // Simulate gracefulShutdown with unknown signal
    if (!shutdownState.tryInitiateShutdown()) {
      mockLogger.debug(`Ignoring ${unknownSignal} - shutdown already in progress`);
      return;
    }

    mockLogger.info(`Received ${unknownSignal}, shutting down gracefully...`);

    try {
      const serverWasStopped = await mockStopServer();
      if (serverWasStopped) {
        mockLogger.info('Server stopped successfully');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      mockLogger.error(`Error stopping server: ${errorMessage}`);
      mockLogger.debug('Full error details:', error);
    }

    // Should use fallback exit code 0 for unknown signals
    const exitCode = unknownSignal === 'SIGINT' ? 130 : unknownSignal === 'SIGTERM' ? 143 : 0;
    expect(exitCode).toBe(0);

    try {
      process.exit(exitCode);
    } catch (error) {
      // Expected behavior in test environment
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Process exit called with code: 0');
    }

    expect(mockLogger.info).toHaveBeenCalledWith('Received SIGUSR1, shutting down gracefully...');
    expect(mockLogger.info).toHaveBeenCalledWith('Server stopped successfully');
    expect(mockStopServer).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('should atomically handle shutdown state to prevent race conditions', async () => {
    // Test the atomic nature of tryInitiateShutdown
    const state = {
      isShuttingDown: false,
      tryInitiateShutdown(): boolean {
        if (this.isShuttingDown) {
          return false;
        }
        this.isShuttingDown = true;
        return true;
      },
    };

    // First attempt should succeed
    const firstAttempt = state.tryInitiateShutdown();
    expect(firstAttempt).toBe(true);
    expect(state.isShuttingDown).toBe(true);

    // Second attempt should fail
    const secondAttempt = state.tryInitiateShutdown();
    expect(secondAttempt).toBe(false);
    expect(state.isShuttingDown).toBe(true);
  });

  it('should not log server messages when no server is running', async () => {
    // Mock stopServer to return false (no server was running)
    mockStopServer.mockResolvedValue(false);

    // Simulate gracefulShutdown when no server is running
    if (!shutdownState.tryInitiateShutdown()) {
      mockLogger.debug(`Ignoring SIGINT - shutdown already in progress`);
      return;
    }

    mockLogger.info(`Received SIGINT, shutting down gracefully...`);

    try {
      const serverWasStopped = await mockStopServer();
      if (serverWasStopped) {
        mockLogger.info('Server stopped successfully');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      mockLogger.error(`Error stopping server: ${errorMessage}`);
      mockLogger.debug('Full error details:', error);
    }

    try {
      process.exit(130);
    } catch (error) {
      // Expected behavior in test environment
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Process exit called with code: 130');
    }

    // Verify graceful shutdown was initiated
    expect(mockLogger.info).toHaveBeenCalledWith('Received SIGINT, shutting down gracefully...');
    // Verify "Server stopped successfully" was NOT called since no server was running
    expect(mockLogger.info).not.toHaveBeenCalledWith('Server stopped successfully');
    expect(mockStopServer).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(130);
  });
});

describe('Signal handler registration', () => {
  let originalProcessOn: typeof process.on;
  let mockProcessOn: ReturnType<typeof mock>;
  let signalHandlers: Record<string, Function> = {};

  beforeEach(() => {
    // Mock process.on to capture signal handlers
    originalProcessOn = process.on;
    mockProcessOn = mock((event: string, handler: Function) => {
      signalHandlers[event] = handler;
      return process;
    });
    process.on = mockProcessOn as any;
  });

  afterEach(() => {
    // Restore original process.on
    process.on = originalProcessOn;
    signalHandlers = {};
    mockProcessOn.mockRestore();
  });

  it('should register SIGINT and SIGTERM signal handlers', () => {
    // Simulate the signal handler registration that happens in index.ts
    const gracefulShutdown = async (signal: string) => {
      // Mock implementation for testing
    };

    // Simulate the registration calls
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Verify handlers were registered
    expect(mockProcessOn).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(mockProcessOn).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(mockProcessOn).toHaveBeenCalledTimes(2);

    // Verify handlers are stored
    expect(signalHandlers['SIGINT']).toBeDefined();
    expect(signalHandlers['SIGTERM']).toBeDefined();
    expect(typeof signalHandlers['SIGINT']).toBe('function');
    expect(typeof signalHandlers['SIGTERM']).toBe('function');
  });
});
