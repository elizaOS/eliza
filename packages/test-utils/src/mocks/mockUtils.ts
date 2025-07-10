/**
 * Simple mock utility for test utils that doesn't depend on bun:test
 */

export interface MockFunction<T = any> {
  (...args: any[]): T;
  mockReturnValue: (value: T) => MockFunction<T>;
  mockResolvedValue: (value: T) => MockFunction<T>;
  mockRejectedValue: (error: any) => MockFunction<T>;
  mockImplementation: (fn: (...args: any[]) => T) => MockFunction<T>;
  calls: any[][];

  // Bun:test compatibility properties
  mock: {
    calls: any[][];
    results: any[];
  };
}

export function mock<T = any>(implementation?: (...args: any[]) => T): MockFunction<T> {
  const calls: any[][] = [];
  let mockImplementationFn: ((...args: any[]) => T) | undefined = implementation;
  let mockReturnValueValue: T | undefined;
  let mockResolvedValueValue: T | undefined;
  let mockRejectedValueValue: any | undefined;
  let shouldResolve = false;
  let shouldReject = false;

  const fn = function (...args: any[]): T {
    calls.push(args);

    if (mockImplementationFn) {
      return mockImplementationFn(...args);
    }

    if (shouldReject) {
      return Promise.reject(mockRejectedValueValue) as any;
    }

    if (shouldResolve) {
      return Promise.resolve(mockResolvedValueValue) as any;
    }

    return mockReturnValueValue as T;
  } as MockFunction<T>;

  fn.calls = calls;

  // Add bun:test compatibility
  fn.mock = {
    calls,
    results: [],
  };

  fn.mockReturnValue = (value: T) => {
    mockReturnValueValue = value;
    shouldResolve = false;
    shouldReject = false;
    return fn;
  };

  fn.mockResolvedValue = (value: T) => {
    mockResolvedValueValue = value;
    shouldResolve = true;
    shouldReject = false;
    return fn;
  };

  fn.mockRejectedValue = (error: any) => {
    mockRejectedValueValue = error;
    shouldReject = true;
    shouldResolve = false;
    return fn;
  };

  fn.mockImplementation = (implementation: (...args: any[]) => T) => {
    mockImplementationFn = implementation;
    return fn;
  };

  return fn;
}
