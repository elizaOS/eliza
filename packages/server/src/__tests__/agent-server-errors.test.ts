/**
 * Error handling tests for AgentServer
 */

import { describe, it, expect, jest, mock } from 'bun:test';
import { AgentServer } from '../index';

// Mock logger to avoid console output during tests
mock.module('@elizaos/core', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(() => {
      throw new Error('Logger error');
    }),
    success: jest.fn(),
  },
}));

describe('AgentServer Error Handling Tests', () => {
  it('should handle constructor errors gracefully', () => {
    // Logger.debug is mocked to throw error
    expect(() => new AgentServer()).toThrow('Logger error');
  });

  it('should handle initialization errors and log them', async () => {
    // Reset mock for this test
    mock.restore();
    
    mock.module('@elizaos/core', () => ({
      logger: {
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        success: jest.fn(),
      },
    }));

    // Mock database adapter to fail
    mock.module('@elizaos/plugin-sql', () => ({
      default: { name: 'sql', description: 'SQL plugin', adapter: {} },
      createDatabaseAdapter: jest.fn(() => ({
        init: jest.fn().mockRejectedValue(new Error('Initialization failed')),
      })),
      DatabaseMigrationService: jest.fn(() => ({
        initializeWithDatabase: jest.fn().mockResolvedValue(undefined),
        discoverAndRegisterPluginSchemas: jest.fn(),
        runAllPluginMigrations: jest.fn().mockResolvedValue(undefined),
      })),
      plugin: {},
    }));

    const { logger } = await import('@elizaos/core');
    const errorSpy = jest.spyOn(logger, 'error');

    const server = new AgentServer();
    
    await expect(server.initialize()).rejects.toThrow('Initialization failed');
    expect(errorSpy).toHaveBeenCalled();
  });
});