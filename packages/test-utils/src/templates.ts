/**
 * Standardized testing templates and patterns for ElizaOS
 *
 * This module provides consistent testing patterns, templates, and utilities
 * to ensure testing consistency across all packages.
 */

import { Character, Content, IAgentRuntime, logger, Memory, Plugin } from '@elizaos/core';
import { createTestRuntime } from './realRuntime';

/**
 * Standard test configuration interface
 */
export interface TestConfig {
  name: string;
  timeout?: number;
  retries?: number;
  skipCondition?: () => boolean;
  setup?: () => Promise<void>;
  teardown?: () => Promise<void>;
  expectedErrors?: unknown[];
}

/**
 * Template test result interface
 */
export interface TemplateTestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: Error;
  warnings?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Base test template class
 */
export abstract class TestTemplate {
  protected config: TestConfig;
  protected runtime?: IAgentRuntime;

  constructor(config: TestConfig) {
    this.config = config;
  }

  abstract execute(): Promise<TemplateTestResult>;

  protected async setup(): Promise<void> {
    if (this.config.setup) {
      await this.config.setup();
    }
  }

  protected async teardown(): Promise<void> {
    if (this.config.teardown) {
      await this.config.teardown();
    }
  }

  protected shouldSkip(): boolean {
    return this.config.skipCondition?.() ?? false;
  }

  public getConfig(): TestConfig {
    return this.config;
  }
}

/**
 * Unit test template for isolated component testing
 */
export class UnitTestTemplate extends TestTemplate {
  private testFunction: () => Promise<void>;

  constructor(config: TestConfig, testFunction: () => Promise<void>) {
    super(config);
    this.testFunction = testFunction;
  }

  async execute(): Promise<TemplateTestResult> {
    const startTime = Date.now();

    if (this.shouldSkip()) {
      return {
        name: this.config.name,
        passed: true,
        duration: 0,
        warnings: ['Test skipped due to skip condition'],
      };
    }

    try {
      await this.setup();
      await this.testFunction();
      return {
        name: this.config.name,
        passed: true,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        name: this.config.name,
        passed: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      await this.teardown();
    }
  }
}

/**
 * Integration test template for real runtime testing
 */
export class IntegrationTestTemplate extends TestTemplate {
  private testFunction: (runtime: IAgentRuntime) => Promise<void>;
  private character?: Character;

  constructor(
    config: TestConfig,
    testFunction: (runtime: IAgentRuntime) => Promise<void>,
    character?: Character
  ) {
    super(config);
    this.testFunction = testFunction;
    this.character = character;
  }

  async execute(): Promise<TemplateTestResult> {
    const startTime = Date.now();

    if (this.shouldSkip()) {
      return {
        name: this.config.name,
        passed: true,
        duration: 0,
        warnings: ['Test skipped due to skip condition'],
      };
    }

    try {
      await this.setup();

      const { runtime } = await createTestRuntime({
        character: this.character,
      });
      this.runtime = runtime;

      await this.testFunction(runtime);

      return {
        name: this.config.name,
        passed: true,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        name: this.config.name,
        passed: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      await this.teardown();
    }
  }
}

/**
 * Plugin test template for plugin-specific testing
 */
export class PluginTestTemplate extends TestTemplate {
  private plugin: Plugin;
  private testFunction: (runtime: IAgentRuntime, plugin: Plugin) => Promise<void>;

  constructor(
    config: TestConfig,
    plugin: Plugin,
    testFunction: (runtime: IAgentRuntime, plugin: Plugin) => Promise<void>
  ) {
    super(config);
    this.plugin = plugin;
    this.testFunction = testFunction;
  }

  async execute(): Promise<TemplateTestResult> {
    const startTime = Date.now();

    if (this.shouldSkip()) {
      return {
        name: this.config.name,
        passed: true,
        duration: 0,
        warnings: ['Test skipped due to skip condition'],
      };
    }

    try {
      await this.setup();

      const { runtime } = await createTestRuntime({
        character: {
          name: 'Test Agent',
          bio: 'Test agent for plugin testing',
          plugins: [this.plugin.name],
        },
        plugins: [this.plugin],
      });

      await this.testFunction(runtime, this.plugin);

      return {
        name: this.config.name,
        passed: true,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        name: this.config.name,
        passed: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      await this.teardown();
    }
  }
}

/**
 * Error handling test template
 */
export class ErrorTestTemplate extends TestTemplate {
  private testFunction: () => Promise<void>;
  private expectedError: string;

  constructor(config: TestConfig, testFunction: () => Promise<void>, expectedError: string) {
    super(config);
    this.testFunction = testFunction;
    this.expectedError = expectedError;
  }

  async execute(): Promise<TemplateTestResult> {
    const startTime = Date.now();

    if (this.shouldSkip()) {
      return {
        name: this.config.name,
        passed: true,
        duration: 0,
        warnings: ['Test skipped due to skip condition'],
      };
    }

    try {
      await this.setup();
      await this.testFunction();

      // If we reach here, the test should have thrown but didn't
      return {
        name: this.config.name,
        passed: false,
        duration: Date.now() - startTime,
        error: new Error(`Expected ${this.expectedError} error but test completed successfully`),
      };
    } catch (error) {
      const passed = error.category === this.expectedError;

      return {
        name: this.config.name,
        passed,
        duration: Date.now() - startTime,
        error: passed ? undefined : error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      await this.teardown();
    }
  }
}

/**
 * Performance test template
 */
export class PerformanceTestTemplate extends TestTemplate {
  private testFunction: () => Promise<void>;
  private maxDuration: number;
  private maxMemoryMB: number;

  constructor(
    config: TestConfig,
    testFunction: () => Promise<void>,
    maxDuration: number,
    maxMemoryMB: number
  ) {
    super(config);
    this.testFunction = testFunction;
    this.maxDuration = maxDuration;
    this.maxMemoryMB = maxMemoryMB;
  }

  async execute(): Promise<TemplateTestResult> {
    const startTime = Date.now();
    const startMemory = process.memoryUsage().heapUsed;

    if (this.shouldSkip()) {
      return {
        name: this.config.name,
        passed: true,
        duration: 0,
        warnings: ['Test skipped due to skip condition'],
      };
    }

    try {
      await this.setup();
      await this.testFunction();

      const duration = Date.now() - startTime;
      const memoryUsed = (process.memoryUsage().heapUsed - startMemory) / (1024 * 1024);

      const warnings: string[] = [];
      let passed = true;

      if (duration > this.maxDuration) {
        warnings.push(`Test exceeded max duration: ${duration}ms > ${this.maxDuration}ms`);
        passed = false;
      }

      if (memoryUsed > this.maxMemoryMB) {
        warnings.push(
          `Test exceeded max memory: ${memoryUsed.toFixed(2)}MB > ${this.maxMemoryMB}MB`
        );
        passed = false;
      }

      return {
        name: this.config.name,
        passed,
        duration,
        warnings,
        metadata: {
          memoryUsedMB: memoryUsed,
          maxDurationMs: this.maxDuration,
          maxMemoryMB: this.maxMemoryMB,
        },
      };
    } catch (error) {
      return {
        name: this.config.name,
        passed: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      await this.teardown();
    }
  }
}

/**
 * Test suite for organizing related tests
 */
export class TestSuite {
  private tests: TestTemplate[] = [];
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  addTest(test: TestTemplate): void {
    this.tests.push(test);
  }

  async run(): Promise<{
    suiteName: string;
    totalTests: number;
    passed: number;
    failed: number;
    duration: number;
    results: TemplateTestResult[];
  }> {
    const startTime = Date.now();
    const results: TemplateTestResult[] = [];

    logger.info(`Running test suite: ${this.name}`);

    for (const test of this.tests) {
      try {
        const result = await test.execute();
        results.push(result);

        if (result.passed) {
          logger.info(`✓ ${result.name} (${result.duration}ms)`);
        } else {
          logger.error(`✗ ${result.name} (${result.duration}ms): ${result.error?.message}`);
        }
      } catch (error) {
        const errorResult: TemplateTestResult = {
          name: `${test.getConfig().name} (execution error)`,
          passed: false,
          duration: 0,
          error: error instanceof Error ? error : new Error(String(error)),
        };
        results.push(errorResult);
        logger.error(`✗ ${errorResult.name}: ${errorResult.error?.message}`);
      }
    }

    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    const duration = Date.now() - startTime;

    logger.info(
      `Test suite ${this.name} completed: ${passed}/${results.length} passed (${duration}ms)`
    );

    return {
      suiteName: this.name,
      totalTests: results.length,
      passed,
      failed,
      duration,
      results,
    };
  }
}

/**
 * Factory functions for creating common test scenarios
 */

export function createUnitTest(
  name: string,
  testFunction: () => Promise<void>,
  options: Partial<TestConfig> = {}
): UnitTestTemplate {
  return new UnitTestTemplate({ name, timeout: 5000, ...options }, testFunction);
}

export function createIntegrationTest(
  name: string,
  testFunction: (runtime: IAgentRuntime) => Promise<void>,
  character?: Character,
  options: Partial<TestConfig> = {}
): IntegrationTestTemplate {
  return new IntegrationTestTemplate({ name, timeout: 30000, ...options }, testFunction, character);
}

export function createPluginTest(
  name: string,
  plugin: Plugin,
  testFunction: (runtime: IAgentRuntime, plugin: Plugin) => Promise<void>,
  options: Partial<TestConfig> = {}
): PluginTestTemplate {
  return new PluginTestTemplate({ name, timeout: 30000, ...options }, plugin, testFunction);
}

export function createErrorTest(
  name: string,
  testFunction: () => Promise<void>,
  expectedError: any,
  options: Partial<TestConfig> = {}
): ErrorTestTemplate {
  return new ErrorTestTemplate({ name, timeout: 5000, ...options }, testFunction, expectedError);
}

export function createPerformanceTest(
  name: string,
  testFunction: () => Promise<void>,
  maxDurationMs: number,
  maxMemoryMB: number,
  options: Partial<TestConfig> = {}
): PerformanceTestTemplate {
  return new PerformanceTestTemplate(
    { name, timeout: maxDurationMs * 2, ...options },
    testFunction,
    maxDurationMs,
    maxMemoryMB
  );
}

/**
 * Standard test data generators
 */
export class TestDataGenerator {
  static generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  static generateMemory(overrides: Partial<Memory> = {}): Memory {
    return {
      id: this.generateUUID(),
      entityId: this.generateUUID(),
      agentId: this.generateUUID(),
      roomId: this.generateUUID(),
      content: {
        text: 'Test message content',
        source: 'test',
      },
      ...overrides,
    } as Memory;
  }

  static generateCharacter(overrides: Partial<Character> = {}): Character {
    return {
      name: 'Test Agent',
      bio: 'A test agent for automated testing',
      ...overrides,
    };
  }

  static generateContent(overrides: Partial<Content> = {}): Content {
    return {
      text: 'Test content',
      source: 'test',
      ...overrides,
    };
  }
}
