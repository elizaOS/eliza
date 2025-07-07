/**
 * Type definitions for Bun's test module
 */

declare module 'bun:test' {
  export function expect(value: any): {
    toBe(expected: any): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toEqual(expected: any): void;
    toStrictEqual(expected: any): void;
    toContain(expected: any): void;
    toHaveBeenCalled(): void;
    toHaveBeenCalledWith(...args: any[]): void;
    toHaveLength(expected: number): void;
    toHaveProperty(property: string, value?: any): void;
    toThrow(expected?: any): void;
    not: {
      toBe(expected: any): void;
      toBeDefined(): void;
      toBeUndefined(): void;
      toBeNull(): void;
      toBeTruthy(): void;
      toBeFalsy(): void;
      toEqual(expected: any): void;
      toStrictEqual(expected: any): void;
      toContain(expected: any): void;
      toHaveBeenCalled(): void;
      toHaveBeenCalledWith(...args: any[]): void;
      toHaveLength(expected: number): void;
      toHaveProperty(property: string, value?: any): void;
      toThrow(expected?: any): void;
    };
  };

  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;

  export function mock<T extends (...args: any[]) => any>(implementation?: T): T;
  export function spyOn<T extends object, K extends keyof T>(
    object: T,
    method: K
  ): jest.SpyInstance;
}
