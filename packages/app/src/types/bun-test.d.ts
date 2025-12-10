declare module 'bun:test' {
  interface ExpectMatchers<T> {
    toBe(expected: T): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toEqual(expected: T): void;
    toStrictEqual(expected: T): void;
    toContain(expected: T extends string ? string : T extends (infer U)[] ? U : never): void;
    toHaveBeenCalled(): void;
    toHaveBeenCalledWith(...args: unknown[]): void;
    toHaveLength(expected: number): void;
    toHaveProperty(property: string, value?: unknown): void;
    toThrow(expected?: string | RegExp | Error): void;
    not: ExpectMatchers<T>;
  }

  export function expect<T>(value: T): ExpectMatchers<T>;

  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;

  interface SpyInstance {
    toHaveBeenCalled(): void;
    toHaveBeenCalledWith(...args: unknown[]): void;
  }

  export function mock<T extends (...args: unknown[]) => unknown>(implementation?: T): T;
  export function spyOn<T extends object, K extends keyof T>(object: T, method: K): SpyInstance;
}
