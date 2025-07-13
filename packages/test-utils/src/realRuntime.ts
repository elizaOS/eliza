// Note: AgentRuntime is imported dynamically to avoid circular dependencies
import type { Character, IAgentRuntime, Memory, Plugin, UUID } from '@elizaos/core';
import { AgentRuntime, logger, stringToUuid } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { TestDatabaseManager } from './testDatabase';
import {
  TestModelProvider,
  createSpecializedModelProvider,
  createTestModelProvider,
  scenarios,
} from './testModels';

export interface RuntimeConfig {
  character: Character;
  plugins: Array<Plugin | string>;
  databaseUrl?: string;
  apiKeys: Record<string, string>;
  modelProviders?: Record<string, any>;
  isolated?: boolean;
}

export interface RealRuntimeTestResult {
  scenarioName: string;
  passed: boolean;
  errors: string[];
  executedActions: string[];
  createdMemories: number;
  responseTime: number;
  memoryUsage?: number;
}

/**
 * Runtime Test Harness - Creates actual AgentRuntime instances for testing
 * Uses the standard AgentRuntime without any mocks or proxies
 */
export class RuntimeTestHarness {
  private runtimes: Map<string, IAgentRuntime> = new Map();
  private databaseManager: TestDatabaseManager;
  private testId: string;

  constructor(testId?: string) {
    this.testId = testId || `test-${uuidv4().slice(0, 8)}`;
    this.databaseManager = new TestDatabaseManager();
  }

  /**
   * Creates an AgentRuntime instance for testing
   * This uses the standard AgentRuntime - it will actually execute all functionality
   */
  async createTestRuntime(config: RuntimeConfig): Promise<IAgentRuntime> {
    try {
      logger.info(`Creating real test runtime for ${this.testId}`);

      // Create isolated test database
      const databaseAdapter = await this.databaseManager.createIsolatedDatabase(
        `${this.testId}-${Date.now()}`
      );

      // Create real AgentRuntime with actual configuration
      // Dynamic import to avoid circular dependencies
      const runtime = new AgentRuntime({
        character: config.character,
        adapter: databaseAdapter,
      });

      // Register plugins - these are REAL plugins, not mocks
      for (const plugin of config.plugins) {
        if (typeof plugin === 'string') {
          // Load plugin by name
          const loadedPlugin = await this.loadPlugin(plugin);
          await runtime.registerPlugin(loadedPlugin);
        } else {
          // Direct plugin object
          await runtime.registerPlugin(plugin);
        }
      }

      // Initialize runtime - this executes real initialization logic
      await runtime.initialize();

      // Store for cleanup
      this.runtimes.set(runtime.agentId, runtime);

      logger.info(`Successfully created real runtime ${runtime.agentId}`);
      return runtime;
    } catch (error) {
      logger.error(
        `Failed to create test runtime: ${error instanceof Error ? error.message : String(error)}`
      );
      throw new Error(
        `Test runtime creation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Loads a plugin by name from the ElizaOS ecosystem
   * Uses dynamic imports to avoid circular dependencies during build
   */
  private async loadPlugin(pluginName: string): Promise<Plugin> {
    try {
      // Dynamic plugin loading for testing
      logger.info(`Attempting to load plugin: ${pluginName}`);

      // Try to dynamically import the plugin
      let pluginModule;
      try {
        pluginModule = await import(pluginName);
      } catch (importError) {
        logger.warn(
          `Could not import ${pluginName}: ${importError instanceof Error ? importError.message : String(importError)}`
        );
        throw importError;
      }

      // Extract the default export (plugin definition)
      const plugin = pluginModule.default || pluginModule[Object.keys(pluginModule)[0]];

      if (!plugin || typeof plugin !== 'object') {
        throw new Error(`Invalid plugin export from ${pluginName}`);
      }

      logger.info(`Successfully loaded plugin: ${pluginName}`);
      return plugin as Plugin;
    } catch (error) {
      logger.error(
        `Failed to load plugin ${pluginName}: ${error instanceof Error ? error.message : String(error)}`
      );

      // Don't return a fake plugin - throw error to ensure tests use real plugins
      throw new Error(
        `Plugin ${pluginName} must be available for testing. Install it before running tests. Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Creates a test model provider that gives realistic responses
   */
  createRealisticModelProvider(
    scenarios?: Array<{
      prompt: RegExp;
      response: string;
    }>
  ): TestModelProvider {
    const defaultScenarios = [
      {
        prompt: /hello|hi|hey/i,
        response: 'Hello! How can I help you today?',
      },
      {
        prompt: /create.*todo|add.*task/i,
        response: "I'll create that todo item for you right away.",
      },
      {
        prompt: /search|find|look/i,
        response: 'Let me search for that information.',
      },
      {
        prompt: /analyze|review/i,
        response: "I'll analyze this carefully and provide my assessment.",
      },
    ];

    return createTestModelProvider(scenarios || defaultScenarios);
  }

  /**
   * Executes a real message processing test
   */
  async processTestMessage(
    runtime: IAgentRuntime,
    messageText: string,
    options: {
      roomId?: string;
      entityId?: string;
      expectedActions?: string[];
      timeoutMs?: number;
    } = {}
  ): Promise<RealRuntimeTestResult> {
    const startTime = Date.now();
    const roomId = options.roomId || stringToUuid(`test-room-${uuidv4()}`);
    const entityId = options.entityId || stringToUuid(`test-user-${uuidv4()}`);

    try {
      // Create real memory object
      const memory: Memory = {
        id: stringToUuid(`message-${uuidv4()}`),
        entityId: entityId as UUID,
        roomId: roomId as UUID,
        content: {
          text: messageText,
          source: 'test',
        },
        createdAt: Date.now(),
      };

      const _messageId = await runtime.createMemory(memory, 'messages');

      // Process message with real runtime - this executes actual logic
      const responses = await runtime.processActions(memory, [], undefined, undefined);

      const responseTime = Date.now() - startTime;

      // Validate results against expectations
      const result: RealRuntimeTestResult = {
        scenarioName: `Process: "${messageText}"`,
        passed: true,
        errors: [],
        executedActions: [],
        createdMemories: Array.isArray(responses) ? responses.length : 0,
        responseTime,
      };

      // Check if expected actions were executed
      if (options.expectedActions && options.expectedActions.length > 0) {
        const executedActions = await this.getExecutedActions(runtime, roomId);
        const missingActions = options.expectedActions.filter(
          (action) => !executedActions.includes(action)
        );

        if (missingActions.length > 0) {
          result.passed = false;
          result.errors.push(`Missing expected actions: ${missingActions.join(', ')}`);
        }

        result.executedActions = executedActions;
      }

      // Check timeout
      if (options.timeoutMs && responseTime > options.timeoutMs) {
        result.passed = false;
        result.errors.push(
          `Response time ${responseTime}ms exceeded timeout ${options.timeoutMs}ms`
        );
      }

      return result;
    } catch (error) {
      return {
        scenarioName: `Process: "${messageText}"`,
        passed: false,
        errors: [`Runtime error: ${error instanceof Error ? error.message : String(error)}`],
        executedActions: [],
        createdMemories: 0,
        responseTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Gets actions that were actually executed (not mocked)
   */
  private async getExecutedActions(runtime: IAgentRuntime, roomId: string): Promise<string[]> {
    try {
      // Query real database for executed actions
      const memories = await runtime.getMemories({
        roomId: roomId as UUID,
        count: 10,
        tableName: 'messages',
      });

      const actions: string[] = [];
      for (const memory of memories) {
        if (memory.content.actions && Array.isArray(memory.content.actions)) {
          actions.push(...memory.content.actions);
        }
      }

      return [...new Set(actions)]; // Remove duplicates
    } catch (error) {
      logger.warn(
        `Could not retrieve executed actions: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  /**
   * Validates that a runtime is actually functional
   */
  async validateRuntimeHealth(runtime: IAgentRuntime): Promise<{
    healthy: boolean;
    issues: string[];
    services: string[];
    plugins: string[];
  }> {
    const issues: string[] = [];
    const services: string[] = [];
    const plugins: string[] = [];

    try {
      // Check basic functionality
      if (!runtime.agentId) {
        issues.push('Runtime missing agentId');
      }

      if (!runtime.character) {
        issues.push('Runtime missing character');
      }

      // Check database connectivity
      try {
        const healthMemory: Memory = {
          id: stringToUuid('health-check-message'),
          entityId: stringToUuid('health-check-entity'),
          roomId: stringToUuid('health-check-room'),
          content: { text: 'Health check', source: 'test' },
          createdAt: Date.now(),
        };
        await runtime.createMemory(healthMemory, 'test');
      } catch (error) {
        issues.push(
          `Database not functional: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Check services
      try {
        const serviceMap = runtime.services || new Map();
        for (const [name, service] of serviceMap) {
          services.push(name);
          if (!service) {
            issues.push(`Service ${name} is null/undefined`);
          }
        }
      } catch (error) {
        issues.push(
          `Services not accessible: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Check plugins
      try {
        plugins.push(...(runtime.plugins?.map((p) => p.name) || []));
      } catch (error) {
        issues.push(
          `Plugins not accessible: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      return {
        healthy: issues.length === 0,
        issues,
        services,
        plugins,
      };
    } catch (error) {
      return {
        healthy: false,
        issues: [
          `Runtime health check failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
        services,
        plugins,
      };
    }
  }

  /**
   * Cleanup all test resources
   */
  async cleanup(): Promise<void> {
    try {
      logger.info(`Cleaning up test harness ${this.testId}`);

      // Stop all runtimes
      for (const [runtimeId, runtime] of this.runtimes) {
        try {
          await runtime.stop();
          logger.debug(`Stopped runtime ${runtimeId}`);
        } catch (error) {
          logger.warn(
            `Error stopping runtime ${runtimeId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Clear runtime references
      this.runtimes.clear();

      // Cleanup databases
      await this.databaseManager.cleanup();

      logger.info(`Successfully cleaned up test harness ${this.testId}`);
    } catch (error) {
      logger.error(
        `Error during cleanup: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }
}

/**
 * Convenience function to create and configure a test runtime
 */
export async function createTestRuntime(config: Partial<RuntimeConfig> = {}): Promise<{
  runtime: IAgentRuntime;
  harness: RuntimeTestHarness;
}> {
  const harness = new RuntimeTestHarness();

  const defaultCharacter: Character = {
    name: 'TestAgent',
    system: 'You are a helpful test agent.',
    bio: ['I am a test agent used for integration testing.'],
    messageExamples: [],
    postExamples: [],
    topics: ['testing'],
    knowledge: [],
    plugins: [],
  };

  const runtime = await harness.createTestRuntime({
    character: defaultCharacter,
    plugins: [],
    apiKeys: { OPENAI_API_KEY: 'test-key' },
    ...config,
  });

  return { runtime, harness };
}

/**
 * Helper to run a quick integration test
 */
export async function runIntegrationTest(
  testName: string,
  testFn: (runtime: IAgentRuntime) => Promise<void>,
  config?: Partial<RuntimeConfig>
): Promise<RealRuntimeTestResult> {
  const startTime = Date.now();
  let harness: RuntimeTestHarness | undefined;

  try {
    const { runtime, harness: testHarness } = await createTestRuntime(config);
    harness = testHarness;

    await testFn(runtime);

    return {
      scenarioName: testName,
      passed: true,
      errors: [],
      executedActions: [],
      createdMemories: 0,
      responseTime: Date.now() - startTime,
    };
  } catch (error) {
    return {
      scenarioName: testName,
      passed: false,
      errors: [error instanceof Error ? error.message : String(error)],
      executedActions: [],
      createdMemories: 0,
      responseTime: Date.now() - startTime,
    };
  } finally {
    if (harness) {
      await harness.cleanup();
    }
  }
}

// Re-export helper functions from test-models
export { createSpecializedModelProvider, scenarios };
