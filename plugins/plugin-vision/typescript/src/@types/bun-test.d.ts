declare module 'bun:test' {
  export interface TestAPI {
    test: TestFn;
    describe: DescribeFn;
    it: TestFn;
    expect: ExpectAPI;
    beforeAll: BeforeAfterFn;
    beforeEach: BeforeAfterFn;
    afterAll: BeforeAfterFn;
    afterEach: BeforeAfterFn;
    mock: MockFn;
  }

  export interface TestFn {
    (name: string, fn: () => void | Promise<void>): void;
    (name: string, fn: () => void | Promise<void>, timeout?: number): void;
    skip: TestFn;
    only: TestFn;
    todo: TestFn;
  }

  export interface DescribeFn {
    (name: string, fn: () => void): void;
    skip: DescribeFn;
    only: DescribeFn;
    todo: DescribeFn;
  }

  export interface BeforeAfterFn {
    (fn: () => void | Promise<void>): void;
  }

  export interface MockFn {
    <T extends (...args: any[]) => any>(fn?: T): MockedFunction<T>;
    (): MockedFunction<() => any>;
    module: (moduleName: string) => any;
    restore: () => void;
  }

  export interface MockedFunction<T extends (...args: any[]) => any> {
    (...args: Parameters<T>): ReturnType<T>;
    mockReturnValue: (value: ReturnType<T>) => MockedFunction<T>;
    mockReturnValueOnce: (value: ReturnType<T>) => MockedFunction<T>;
    mockReturnThis: () => MockedFunction<T>;
    mockResolvedValue: (value: Awaited<ReturnType<T>>) => MockedFunction<T>;
    mockResolvedValueOnce: (value: Awaited<ReturnType<T>>) => MockedFunction<T>;
    mockRejectedValue: (value: any) => MockedFunction<T>;
    mockRejectedValueOnce: (value: any) => MockedFunction<T>;
    mockImplementation: (fn: T) => MockedFunction<T>;
    mockImplementationOnce: (fn: T) => MockedFunction<T>;
    mockClear: () => void;
    mockReset: () => void;
    mockRestore: () => void;
    getMockName: () => string;
    mockName: (name: string) => MockedFunction<T>;
    mock: {
      calls: Parameters<T>[];
      instances: any[];
      contexts: any[];
      results: Array<{ type: 'return' | 'throw'; value: any }>;
      lastCall?: Parameters<T>;
    };
  }

  export interface ExpectAPI {
    <T>(actual: T): Matchers<T>;
    extend: (matchers: Record<string, any>) => void;
    anything: () => any;
    any: (constructor: any) => any;
    arrayContaining: (array: any[]) => any;
    objectContaining: (object: Record<string, any>) => any;
    stringContaining: (string: string) => any;
    stringMatching: (regexp: RegExp) => any;
    addSnapshotSerializer: (serializer: any) => void;
  }

  export interface Matchers<T> {
    toBe: (expected: T) => void;
    toEqual: (expected: T) => void;
    toStrictEqual: (expected: T) => void;
    toBeCloseTo: (expected: number, precision?: number) => void;
    toBeGreaterThan: (expected: number) => void;
    toBeGreaterThanOrEqual: (expected: number) => void;
    toBeLessThan: (expected: number) => void;
    toBeLessThanOrEqual: (expected: number) => void;
    toBeTruthy: () => void;
    toBeFalsy: () => void;
    toBeUndefined: () => void;
    toBeNull: () => void;
    toBeDefined: () => void;
    toBeNaN: () => void;
    toBeInstanceOf: (expected: any) => void;
    toContain: (expected: any) => void;
    toContainEqual: (expected: any) => void;
    toHaveLength: (expected: number) => void;
    toHaveProperty: (keyPath: string, value?: any) => void;
    toMatch: (expected: string | RegExp) => void;
    toMatchObject: (expected: Record<string, any>) => void;
    toMatchSnapshot: (hint?: string) => void;
    toMatchInlineSnapshot: (snapshot?: string) => void;
    toThrow: (expected?: string | RegExp | Error) => void;
    toThrowError: (expected?: string | RegExp | Error) => void;
    toHaveBeenCalled: () => void;
    toHaveBeenCalledTimes: (expected: number) => void;
    toHaveBeenCalledWith: (...expected: any[]) => void;
    toHaveBeenLastCalledWith: (...expected: any[]) => void;
    toHaveBeenNthCalledWith: (call: number, ...expected: any[]) => void;
    toHaveReturned: () => void;
    toHaveReturnedTimes: (expected: number) => void;
    toHaveReturnedWith: (expected: any) => void;
    toHaveLastReturnedWith: (expected: any) => void;
    toHaveNthReturnedWith: (call: number, expected: any) => void;
    resolves: Matchers<Awaited<T>>;
    rejects: Matchers<any>;
    not: Matchers<T>;
  }

  export const test: TestFn;
  export const describe: DescribeFn;
  export const it: TestFn;
  export const expect: ExpectAPI;
  export const beforeAll: BeforeAfterFn;
  export const beforeEach: BeforeAfterFn;
  export const afterAll: BeforeAfterFn;
  export const afterEach: BeforeAfterFn;
  export const mock: MockFn;
}
