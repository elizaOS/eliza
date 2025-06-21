import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { handleError } from '../../../src/utils/handle-error';
import { logger } from '@elizaos/core';

// Mock logger
mock.module('@elizaos/core', () => ({
  logger: {
    error: vi.fn(),
  },
}));

describe('handleError', () => {
  let mockExit: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock process.exit for each test
    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      // Don't actually exit, just return undefined
      return undefined as never;
    });
  });

  afterEach(() => {
    mockExit.mockRestore();
    vi.restoreAllMocks();
  });

  it('should handle Error objects with message', () => {
    const error = new Error('Test error message');

    handleError(error);
    expect(logger.error).toHaveBeenCalledWith('An error occurred:', error);
    expect(logger.error).toHaveBeenCalledWith('Error details:', 'Test error message');
    expect(logger.error).toHaveBeenCalledWith('Stack trace:', error.stack);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should handle Error objects with stack trace', () => {
    const error = new Error('Test error');
    error.stack = 'Error: Test error\n    at testFunction (test.js:10:5)';

    handleError(error);
    expect(logger.error).toHaveBeenCalledWith('An error occurred:', error);
    expect(logger.error).toHaveBeenCalledWith('Error details:', 'Test error');
    expect(logger.error).toHaveBeenCalledWith('Stack trace:', error.stack);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should handle string errors', () => {
    const error = 'String error message';

    handleError(error);
    expect(logger.error).toHaveBeenCalledWith('An error occurred:', error);
    expect(logger.error).toHaveBeenCalledWith('Unknown error type:', 'string');
    expect(logger.error).toHaveBeenCalledWith('Error value:', error);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should handle unknown error types', () => {
    const error = { custom: 'error object' };

    handleError(error);
    expect(logger.error).toHaveBeenCalledWith('An error occurred:', error);
    expect(logger.error).toHaveBeenCalledWith('Unknown error type:', 'object');
    expect(logger.error).toHaveBeenCalledWith('Error value:', error);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should handle null error', () => {
    handleError(null);
    expect(logger.error).toHaveBeenCalledWith('An error occurred:', null);
    expect(logger.error).toHaveBeenCalledWith('Unknown error type:', 'object');
    expect(logger.error).toHaveBeenCalledWith('Error value:', null);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should handle undefined error', () => {
    handleError(undefined);
    expect(logger.error).toHaveBeenCalledWith('An error occurred:', undefined);
    expect(logger.error).toHaveBeenCalledWith('Unknown error type:', 'undefined');
    expect(logger.error).toHaveBeenCalledWith('Error value:', undefined);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should handle error objects without message', () => {
    const error = new Error(); // Message will be an empty string

    handleError(error);
    expect(logger.error).toHaveBeenCalledWith('An error occurred:', error);
    expect(logger.error).toHaveBeenCalledWith('Error details:', '');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should handle circular reference errors', () => {
    const error: any = { prop: 'value' };
    error.circular = error; // Create circular reference

    handleError(error);
    expect(logger.error).toHaveBeenCalledWith('An error occurred:', error);
    expect(logger.error).toHaveBeenCalledWith('Unknown error type:', 'object');
    expect(logger.error).toHaveBeenCalledWith('Error value:', error);
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
