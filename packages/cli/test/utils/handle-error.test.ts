import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

// Mock dependencies
vi.mock('@elizaos/core', () => ({
  logger: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('../../src/commands/agent', () => ({
  getAgentRuntimeUrl: vi.fn(),
}));

vi.mock('yoctocolors', () => ({
  default: {
    red: vi.fn((text) => `RED:${text}`),
  },
}));

// Mock global fetch with proper typing
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

import { handleError, checkServer } from '../../src/utils/handle-error';
import { logger } from '@elizaos/core';
import { getAgentRuntimeUrl } from '../../src/commands/agent';
import colors from 'yoctocolors';

describe('handle-error', () => {
  // Mock process.exit to prevent actual process termination during tests
  const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleError', () => {
    it('should handle ENOSPC error with special formatting', () => {
      const error = new Error('ENOSPC: no space left on device');

      expect(() => handleError(error)).toThrow('process.exit called');

      expect(colors.red).toHaveBeenCalledWith(
        'ERROR: No space left on device! Please free up disk space and try again.'
      );
      expect(colors.red).toHaveBeenCalledWith(error.message);
      expect(logger.error).toHaveBeenCalledWith(
        'RED:ERROR: No space left on device! Please free up disk space and try again.'
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should handle "no space left on device" error string with special formatting', () => {
      const error = new Error('Something failed: no space left on device');

      expect(() => handleError(error)).toThrow('process.exit called');

      expect(colors.red).toHaveBeenCalledWith(
        'ERROR: No space left on device! Please free up disk space and try again.'
      );
      expect(logger.error).toHaveBeenCalledWith(
        'RED:ERROR: No space left on device! Please free up disk space and try again.'
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should handle string error with ENOSPC', () => {
      const error = 'ENOSPC error occurred';

      expect(() => handleError(error)).toThrow('process.exit called');

      expect(colors.red).toHaveBeenCalledWith(
        'ERROR: No space left on device! Please free up disk space and try again.'
      );
      expect(colors.red).toHaveBeenCalledWith(error);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should handle regular Error instance', () => {
      const error = new Error('Regular error message');
      error.stack = 'Error stack trace';

      expect(() => handleError(error)).toThrow('process.exit called');

      expect(logger.error).toHaveBeenCalledWith('An error occurred:', error);
      expect(logger.error).toHaveBeenCalledWith('Error details:', error.message);
      expect(logger.error).toHaveBeenCalledWith('Stack trace:', error.stack);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should handle Error instance without stack trace', () => {
      const error = new Error('Error without stack');
      delete error.stack;

      expect(() => handleError(error)).toThrow('process.exit called');

      expect(logger.error).toHaveBeenCalledWith('An error occurred:', error);
      expect(logger.error).toHaveBeenCalledWith('Error details:', error.message);
      expect(logger.error).toHaveBeenCalledWith('Stack trace:', undefined);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should handle string error', () => {
      const error = 'Simple string error';

      expect(() => handleError(error)).toThrow('process.exit called');

      expect(logger.error).toHaveBeenCalledWith('An error occurred:', error);
      expect(logger.error).toHaveBeenCalledWith('Unknown error type:', 'string');
      expect(logger.error).toHaveBeenCalledWith('Error value:', error);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should handle unknown error types', () => {
      const error = { custom: 'object error' };

      expect(() => handleError(error)).toThrow('process.exit called');

      expect(logger.error).toHaveBeenCalledWith('An error occurred:', error);
      expect(logger.error).toHaveBeenCalledWith('Unknown error type:', 'object');
      expect(logger.error).toHaveBeenCalledWith('Error value:', error);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should handle null error', () => {
      const error = null;

      expect(() => handleError(error)).toThrow('process.exit called');

      expect(logger.error).toHaveBeenCalledWith('An error occurred:', error);
      expect(logger.error).toHaveBeenCalledWith('Unknown error type:', 'object');
      expect(logger.error).toHaveBeenCalledWith('Error value:', error);
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('checkServer', () => {
    const mockOpts = { remoteUrl: 'http://localhost:3000' };

    beforeEach(() => {
      (getAgentRuntimeUrl as Mock).mockReturnValue('http://localhost:3000');
    });

    it('should succeed when server responds with ok status', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
      };
      mockFetch.mockResolvedValue(mockResponse);

      await checkServer(mockOpts);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/api/agents');
      expect(logger.success).toHaveBeenCalledWith('ElizaOS server is running');
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('should exit when server responds with error status', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      };
      mockFetch.mockResolvedValue(mockResponse);

      await expect(checkServer(mockOpts)).rejects.toThrow('process.exit called');

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/api/agents');
      expect(logger.error).toHaveBeenCalledWith(
        'Unable to connect to ElizaOS server, likely not running or not accessible!'
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should exit when fetch throws network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(checkServer(mockOpts)).rejects.toThrow('process.exit called');

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/api/agents');
      expect(logger.error).toHaveBeenCalledWith(
        'Unable to connect to ElizaOS server, likely not running or not accessible!'
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should use correct URL from getAgentRuntimeUrl', async () => {
      (getAgentRuntimeUrl as Mock).mockReturnValue('http://custom-host:8080');
      const mockResponse = { ok: true };
      mockFetch.mockResolvedValue(mockResponse);

      await checkServer(mockOpts);

      expect(getAgentRuntimeUrl).toHaveBeenCalledWith(mockOpts);
      expect(mockFetch).toHaveBeenCalledWith('http://custom-host:8080/api/agents');
    });
  });
});
