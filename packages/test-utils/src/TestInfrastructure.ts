import type { IAgentRuntime, IDatabaseAdapter, UUID, Character, Memory } from '@elizaos/core';
import { createTestRuntime } from './realRuntime';
import { stringToUuid } from '@elizaos/core';
import { createUniqueUuid as _createUniqueUuid } from '@elizaos/core';

export interface TestEnvironmentConfig {
  /** Test isolation level */
  isolation: 'unit' | 'integration' | 'e2e';
  /** Use real database vs in-memory */
  useRealDatabase: boolean;
  /** Performance thresholds */
  performanceThresholds?: PerformanceThresholds;
  /** Test data configuration */
  testData?: TestDataConfig;
}

export interface PerformanceThresholds {
  actionExecution: number; // ms
  memoryRetrieval: number; // ms
  databaseQuery: number; // ms
  modelInference: number; // ms
}

export interface TestDataConfig {
  entities: number;
  memories: number;
  messages: number;
  relationships: number;
}

export const DEFAULT_PERFORMANCE_THRESHOLDS: PerformanceThresholds = {
  actionExecution: 5000,
  memoryRetrieval: 1000,
  databaseQuery: 500,
  modelInference: 10000,
};

export const DEFAULT_TEST_DATA: TestDataConfig = {
  entities: 5,
  memories: 10,
  messages: 20,
  relationships: 3,
};

/**
 * Test environment manager - ensures proper setup/teardown
 */
export class TestEnvironment {
  private static activeEnvironments = new Map<string, TestEnvironment>();
  private runtime: IAgentRuntime | null = null;
  private databaseAdapter: IDatabaseAdapter | null = null;
  private testId: string;
  private config: TestEnvironmentConfig;

  constructor(testId: string, config: TestEnvironmentConfig) {
    this.testId = testId;
    this.config = config;
  }

  static async create(
    testId: string,
    config: Partial<TestEnvironmentConfig> = {}
  ): Promise<TestEnvironment> {
    const fullConfig: TestEnvironmentConfig = {
      isolation: 'integration',
      useRealDatabase: true,
      performanceThresholds: DEFAULT_PERFORMANCE_THRESHOLDS,
      testData: DEFAULT_TEST_DATA,
      ...config,
    };

    const env = new TestEnvironment(testId, fullConfig);
    await env.setup();

    TestEnvironment.activeEnvironments.set(testId, env);
    return env;
  }

  private async setup(): Promise<void> {
    // Force real database for integration tests
    if (this.config.useRealDatabase) {
      process.env.FORCE_MOCK_DB = 'false';
    }

    // Create runtime with isolated test character
    const testCharacter = this.createTestCharacter();
    const runtimeResult = await createTestRuntime({
      character: testCharacter,
      plugins: [],
      apiKeys: {},
      isolated: true,
    });
    this.runtime = runtimeResult.runtime;
    this.databaseAdapter = (this.runtime as any).adapter;

    // Ensure database adapter is available
    if (!this.databaseAdapter) {
      throw new Error(`Database adapter not available in runtime for test ${this.testId}`);
    }

    // Verify we have a real database adapter
    if (this.config.useRealDatabase && this.databaseAdapter.constructor.name.includes('Mock')) {
      throw new Error(
        `Test ${this.testId} requires real database but got mock adapter: ${this.databaseAdapter.constructor.name}`
      );
    }

    // Seed test data if specified
    if (this.config.testData) {
      await this.seedTestData();
    }
  }

  private createTestCharacter(): Character {
    return {
      name: `TestAgent_${this.testId}`,
      bio: `Test agent for ${this.testId}`,
      system: 'You are a test agent for ElizaOS integration testing.',
      messageExamples: [],
      knowledge: [],
      plugins: [],
      settings: {
        testMode: true,
        testId: this.testId,
      },
    };
  }

  private async seedTestData(): Promise<void> {
    if (!this.runtime || !this.config.testData) {
      return;
    }

    const {
      entities,
      memories: _memories,
      messages: _messages,
      relationships: _relationships,
    } = this.config.testData;

    // Create test entities
    for (let i = 0; i < entities; i++) {
      await TestDataBuilder.createEntity(this.runtime, {
        names: [`TestEntity_${this.testId}_${i}`],
        metadata: { testId: this.testId, index: i },
      });
    }

    // Create test memories, messages, relationships...
    // Implementation continues based on test data config
  }

  async teardown(): Promise<void> {
    if (this.runtime) {
      // Clean up test data
      await this.cleanupTestData();

      // Stop runtime
      if (typeof this.runtime.stop === 'function') {
        await this.runtime.stop();
      }
    }

    TestEnvironment.activeEnvironments.delete(this.testId);
  }

  private async cleanupTestData(): Promise<void> {
    if (!this.databaseAdapter) {
      return;
    }

    try {
      // Delete test-specific data based on testId in metadata
      // This requires implementing test data cleanup methods
      console.log(`Cleaning up test data for ${this.testId}`);
    } catch (error) {
      console.warn(`Failed to cleanup test data for ${this.testId}:`, error);
    }
  }

  static async teardownAll(): Promise<void> {
    const teardownPromises = Array.from(TestEnvironment.activeEnvironments.values()).map((env) =>
      env.teardown()
    );

    await Promise.all(teardownPromises);
    TestEnvironment.activeEnvironments.clear();
  }

  get testRuntime(): IAgentRuntime {
    if (!this.runtime) {
      throw new Error(`Test environment ${this.testId} not properly initialized`);
    }
    return this.runtime;
  }

  get testDatabase(): IDatabaseAdapter {
    if (!this.databaseAdapter) {
      throw new Error(`Test database ${this.testId} not properly initialized`);
    }
    return this.databaseAdapter;
  }

  /**
   * Performance monitoring wrapper
   */
  async measurePerformance<T>(
    operation: () => Promise<T>,
    threshold: keyof PerformanceThresholds,
    description: string
  ): Promise<T> {
    const startTime = Date.now();
    const result = await operation();
    const duration = Date.now() - startTime;

    const expectedThreshold = this.config.performanceThresholds![threshold];
    if (duration > expectedThreshold) {
      console.warn(
        `Performance warning: ${description} took ${duration}ms (threshold: ${expectedThreshold}ms)`
      );
    }

    return result;
  }
}

/**
 * Test data builder for creating realistic test scenarios
 */
export class TestDataBuilder {
  static async createEntity(
    runtime: IAgentRuntime,
    data: {
      names: string[];
      metadata?: Record<string, any>;
    }
  ): Promise<UUID> {
    const entityId = stringToUuid(`entity-${Date.now()}-${Math.random()}`);
    await runtime.createEntity({
      id: entityId,
      names: data.names,
      metadata: data.metadata || {},
      agentId: runtime.agentId,
    });
    return entityId;
  }

  static async createTestConversation(
    runtime: IAgentRuntime,
    participants: string[],
    messageCount: number = 5
  ) {
    // Create room
    const roomId = stringToUuid(`room-${Date.now()}-${Math.random()}`);

    // Add participants
    for (const participantId of participants) {
      await runtime.addParticipant(participantId as any, roomId);
    }

    // Create conversation messages
    const messages: Memory[] = [];
    for (let i = 0; i < messageCount; i++) {
      const message = {
        entityId: participants[i % participants.length] as any,
        roomId,
        content: {
          text: `Test message ${i + 1} in conversation`,
          action: i % 3 === 0 ? 'RESPOND' : undefined,
        },
      };
      messages.push(message);
      await runtime.createMemory(message, 'messages');
    }

    return { roomId, messages };
  }

  static async createTestMemories(runtime: IAgentRuntime, roomId: string, count: number = 10) {
    const memories: Memory[] = [];
    for (let i = 0; i < count; i++) {
      const memory = {
        entityId: runtime.agentId,
        roomId: roomId as any,
        content: {
          text: `Test memory ${i + 1}`,
          type: 'fact',
          importance: Math.random(),
        },
        embedding: new Array(1536).fill(0).map(() => Math.random() - 0.5), // Mock embedding
      };
      await runtime.createMemory(memory, 'facts');
      memories.push(memory);
    }
    return memories;
  }
}

// Global test setup and teardown
if (typeof globalThis !== 'undefined') {
  // Clean up any remaining test environments on process exit
  const cleanup = () => {
    TestEnvironment.teardownAll().catch(console.error);
  };

  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('uncaughtException', cleanup);
}
