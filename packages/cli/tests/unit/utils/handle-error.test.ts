import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleError } from '../../../src/utils/handle-error';
import { logger } from '@elizaos/core';

// Mock logger
vi.mock('@elizaos/core', () => ({
  logger: {
    error: vi.fn(),
  }
}));

// Mock process.exit
const mockExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
  throw new Error(`process.exit called with code ${code}`);
});

describe('handleError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should handle Error objects with message', () => {
    const error = new Error('Test error message');
    
    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    expect(logger.error).toHaveBeenCalledWith('Test error message');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should handle Error objects with stack trace', () => {
    const error = new Error('Test error');
    error.stack = 'Error: Test error\n    at testFunction (test.js:10:5)';
    
    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    expect(logger.error).toHaveBeenCalledWith('Test error');
    expect(logger.error).toHaveBeenCalledWith('Error: Test error\n    at testFunction (test.js:10:5)');
  });

  it('should handle string errors', () => {
    const error = 'String error message';
    
    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    expect(logger.error).toHaveBeenCalledWith('String error message');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should handle unknown error types', () => {
    const error = { custom: 'error object' };
    
    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    expect(logger.error).toHaveBeenCalledWith('An unknown error occurred');
    expect(logger.error).toHaveBeenCalledWith(JSON.stringify({ custom: 'error object' }, null, 2));
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should handle null error', () => {
    expect(() => handleError(null)).toThrow('process.exit called with code 1');
    expect(logger.error).toHaveBeenCalledWith('An unknown error occurred');
    expect(logger.error).toHaveBeenCalledWith('null');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should handle undefined error', () => {
    expect(() => handleError(undefined)).toThrow('process.exit called with code 1');
    expect(logger.error).toHaveBeenCalledWith('An unknown error occurred');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should handle error objects without message', () => {
    const error = new Error();
    
    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    expect(logger.error).toHaveBeenCalledWith('An error occurred');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should handle circular reference errors', () => {
    const error: any = { prop: 'value' };
    error.circular = error; // Create circular reference
    
    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    expect(logger.error).toHaveBeenCalledWith('An unknown error occurred');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[object Object]'));
    expect(mockExit).toHaveBeenCalledWith(1);
  });
}); 