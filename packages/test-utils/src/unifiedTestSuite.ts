/**
 * Unified Testing Infrastructure for ElizaOS
 *
 * This module provides the standardized TestSuite interface that all ElizaOS packages
 * should use for consistent testing across the monorepo. It integrates with Bun's
 * testing framework while providing a unified API.
 */

import { beforeEach, afterEach } from 'bun:test';

/**
 * Unified TestSuite class for consistent testing across ElizaOS packages
 * This provides the same interface used by all migrated packages
 */
export class TestSuite {
  private tests: Array<{
    name: string;
    fn: (context: any) => Promise<void> | void;
  }> = [];
  private beforeEachFn?: (context: any) => Promise<void> | void;
  private afterEachFn?: (context: any) => Promise<void> | void;

  constructor(private name: string) {}

  beforeEach<T = any>(fn: (context: T) => Promise<void> | void): void {
    this.beforeEachFn = fn;
  }

  afterEach<T = any>(fn: (context: T) => Promise<void> | void): void {
    this.afterEachFn = fn;
  }

  addTest<T = any>(name: string, fn: (context: T) => Promise<void> | void): void {
    this.tests.push({ name, fn });
  }

  run(): void {
    // Import Bun test function
    const { test: bunTest } = require('bun:test');

    // Set up the test suite using Bun's test framework
    const context: any = {};

    if (this.beforeEachFn) {
      beforeEach(() => {
        return this.beforeEachFn?.(context);
      });
    }

    if (this.afterEachFn) {
      afterEach(() => {
        return this.afterEachFn?.(context);
      });
    }

    // Register each test with Bun immediately
    for (const test of this.tests) {
      bunTest(test.name, async () => {
        return test.fn(context);
      });
    }
  }
}

/**
 * Helper function to create a TestSuite for unit tests
 * This is the primary way packages should create test suites
 */
export function createUnitTest(name: string): TestSuite {
  const testSuite = new TestSuite(name);

  // Auto-run the test suite immediately
  // Use setImmediate to ensure the tests are added first
  setImmediate(() => {
    testSuite.run();
  });

  return testSuite;
}

/**
 * Helper function to create a TestSuite for plugin tests
 */
export function createPluginTest(name: string): TestSuite {
  return createUnitTest(`Plugin: ${name}`);
}

/**
 * Helper function to create a TestSuite for integration tests
 */
export function createIntegrationTest(name: string): TestSuite {
  return createUnitTest(`Integration: ${name}`);
}

/**
 * Helper function to create a TestSuite for E2E tests
 */
export function createE2ETest(name: string): TestSuite {
  return createUnitTest(`E2E: ${name}`);
}
