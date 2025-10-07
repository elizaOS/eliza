import { type IAgentRuntime } from '@elizaos/core';

/**
 * Base class for E2E test suites that work with the ElizaOS test runner.
 *
 * This follows the ElizaOS testing pattern where test classes are instantiated
 * by the TestRunner and provided with a live IAgentRuntime instance.
 */
export abstract class TestSuite {
  /** Human-readable name for this test suite */
  public abstract name: string;

  /** Map of test names to test functions */
  public abstract tests: Record<string, (runtime: IAgentRuntime) => Promise<void>>;

  /**
   * Simple assertion helper for test validation.
   * Throws an error if the condition is false.
   */
  protected expect(actual: any): {
    toBe: (expected: any) => void;
    toEqual: (expected: any) => void;
    toBeDefined: () => void;
    toBeUndefined: () => void;
    toBeNull: () => void;
    toBeGreaterThan: (expected: number) => void;
    toBeLessThan: (expected: number) => void;
    toContain: (expected: any) => void;
    toThrow: () => void;
  } {
    return {
      toBe: (expected: any) => {
        if (actual !== expected) {
          throw new Error(`Expected ${actual} to be ${expected}`);
        }
      },
      toEqual: (expected: any) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(
            `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`
          );
        }
      },
      toBeDefined: () => {
        if (actual === undefined) {
          throw new Error(`Expected ${actual} to be defined`);
        }
      },
      toBeUndefined: () => {
        if (actual !== undefined) {
          throw new Error(`Expected ${actual} to be undefined`);
        }
      },
      toBeNull: () => {
        if (actual !== null) {
          throw new Error(`Expected ${actual} to be null`);
        }
      },
      toBeGreaterThan: (expected: number) => {
        if (actual <= expected) {
          throw new Error(`Expected ${actual} to be greater than ${expected}`);
        }
      },
      toBeLessThan: (expected: number) => {
        if (actual >= expected) {
          throw new Error(`Expected ${actual} to be less than ${expected}`);
        }
      },
      toContain: (expected: any) => {
        if (Array.isArray(actual)) {
          if (!actual.includes(expected)) {
            throw new Error(`Expected array ${JSON.stringify(actual)} to contain ${expected}`);
          }
        } else if (typeof actual === 'string') {
          if (!actual.includes(expected)) {
            throw new Error(`Expected string "${actual}" to contain "${expected}"`);
          }
        } else {
          throw new Error(`Cannot check if ${typeof actual} contains ${expected}`);
        }
      },
      toThrow: () => {
        let threw = false;
        try {
          if (typeof actual === 'function') {
            actual();
          }
        } catch (e) {
          threw = true;
        }
        if (!threw) {
          throw new Error(`Expected function to throw an error`);
        }
      },
    };
  }
}
