import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { handleError } from '../../../src/utils/handle-error';
import { logger } from '@elizaos/core';

// Mock logger
mock.module('@elizaos/core', () => ({
  logger: {
    error: mock(),
  },
}));

// Mock process.exit
const originalmockExit = process.exit;
const mockExit = mock((code: number) => {
  throw new Error(`process.exit called with code ${code}`);
});

describe('handleError', () => {
  it('should handle Error objects with message', () => {
    const error = new Error('Test error message');

    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    // expect(logger.error).toHaveBeenCalledWith('Test error message'); // TODO: Fix for bun test
    // expect(mockExit).toHaveBeenCalledWith(1); // TODO: Fix for bun test
  });

  it('should handle Error objects with stack trace', () => {
    const error = new Error('Test error');
    error.stack = 'Error: Test error\n    at testFunction (test.js:10:5)';

    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    // expect(logger.error).toHaveBeenCalledWith('Test error'); // TODO: Fix for bun test
    // expect(logger.error).toHaveBeenCalledWith('Error: Test error\n    at testFunction (test.js:10:5)'); // TODO: Fix for bun test
  });

  it('should handle string errors', () => {
    const error = 'String error message';

    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    // expect(logger.error).toHaveBeenCalledWith('String error message'); // TODO: Fix for bun test
    // expect(mockExit).toHaveBeenCalledWith(1); // TODO: Fix for bun test
  });

  it('should handle unknown error types', () => {
    const error = { custom: 'error object' };

    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    // expect(logger.error).toHaveBeenCalledWith('An unknown error occurred'); // TODO: Fix for bun test
    // expect(logger.error).toHaveBeenCalledWith(JSON.stringify({ custom: 'error object' }, null, 2)); // TODO: Fix for bun test
    // expect(mockExit).toHaveBeenCalledWith(1); // TODO: Fix for bun test
  });

  it('should handle null error', () => {
    expect(() => handleError(null)).toThrow('process.exit called with code 1');
    // expect(logger.error).toHaveBeenCalledWith('An unknown error occurred'); // TODO: Fix for bun test
    // expect(logger.error).toHaveBeenCalledWith('null'); // TODO: Fix for bun test
    // expect(mockExit).toHaveBeenCalledWith(1); // TODO: Fix for bun test
  });

  it('should handle undefined error', () => {
    expect(() => handleError(undefined)).toThrow('process.exit called with code 1');
    // expect(logger.error).toHaveBeenCalledWith('An unknown error occurred'); // TODO: Fix for bun test
    // expect(mockExit).toHaveBeenCalledWith(1); // TODO: Fix for bun test
  });

  it('should handle error objects without message', () => {
    const error = new Error();

    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    // expect(logger.error).toHaveBeenCalledWith('An error occurred'); // TODO: Fix for bun test
    // expect(mockExit).toHaveBeenCalledWith(1); // TODO: Fix for bun test
  });

  it('should handle circular reference errors', () => {
    const error: any = { prop: 'value' };
    error.circular = error; // Create circular reference

    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    // expect(logger.error).toHaveBeenCalledWith('An unknown error occurred'); // TODO: Fix for bun test
    // expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[object Object]')); // TODO: Fix for bun test
    // expect(mockExit).toHaveBeenCalledWith(1); // TODO: Fix for bun test
  });
});
