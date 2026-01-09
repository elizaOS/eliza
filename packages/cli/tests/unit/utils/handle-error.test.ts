import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

// Store original references
const originalExit = process.exit;
const originalConsoleError = console.error;

// Capture error output
let errorOutput: string[] = [];
let exitCode: number | undefined;

const captureErrors = () => {
  errorOutput = [];
  exitCode = undefined;

  console.error = (...args: unknown[]) => {
    errorOutput.push(args.map(String).join(' '));
  };

  // Mock process.exit to capture code without actually exiting
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error(`process.exit called with code ${code}`);
  }) as typeof process.exit;
};

const restoreOriginals = () => {
  console.error = originalConsoleError;
  process.exit = originalExit;
};

describe('handleError', () => {
  let handleError: (error: unknown) => void;

  beforeEach(async () => {
    captureErrors();
    // Dynamic import to get fresh module
    const module = await import('../../../src/utils/handle-error');
    handleError = module.handleError;
  });

  afterEach(() => {
    restoreOriginals();
    errorOutput = [];
    exitCode = undefined;
  });

  it('should handle Error objects with message', () => {
    const error = new Error('Test error message');

    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    expect(errorOutput.some((line) => line.includes('Test error message'))).toBe(true);
    expect(exitCode).toBe(1);
  });

  it('should handle Error objects with stack trace', () => {
    const error = new Error('Test error');
    error.stack = 'Error: Test error\n    at testFunction (test.js:10:5)';

    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    expect(errorOutput.some((line) => line.includes('Test error'))).toBe(true);
    expect(exitCode).toBe(1);
  });

  it('should handle string errors', () => {
    const error = 'String error message';

    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    expect(errorOutput.some((line) => line.includes('String error message'))).toBe(true);
    expect(exitCode).toBe(1);
  });

  it('should handle unknown error types', () => {
    const error = { custom: 'error object' };

    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    expect(errorOutput.some((line) => line.includes('unknown') || line.includes('error'))).toBe(
      true
    );
    expect(exitCode).toBe(1);
  });

  it('should handle null error', () => {
    expect(() => handleError(null)).toThrow('process.exit called with code 1');
    expect(
      errorOutput.some(
        (line) => line.includes('unknown') || line.includes('null') || line.includes('error')
      )
    ).toBe(true);
    expect(exitCode).toBe(1);
  });

  it('should handle undefined error', () => {
    expect(() => handleError(undefined)).toThrow('process.exit called with code 1');
    expect(errorOutput.some((line) => line.includes('unknown') || line.includes('error'))).toBe(
      true
    );
    expect(exitCode).toBe(1);
  });

  it('should handle error objects without message', () => {
    const error = new Error();

    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    expect(exitCode).toBe(1);
  });

  it('should handle circular reference errors', () => {
    const error: Record<string, unknown> = { prop: 'value' };
    error.circular = error; // Create circular reference

    expect(() => handleError(error)).toThrow('process.exit called with code 1');
    expect(errorOutput.some((line) => line.includes('unknown') || line.includes('error'))).toBe(
      true
    );
    expect(exitCode).toBe(1);
  });
});
