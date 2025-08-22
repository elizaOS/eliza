/**
 * Test infrastructure validation tests
 */

import { describe, expect, it } from 'bun:test';
import { DatabaseTestRegistry } from './DatabaseTestRegistry';
import { TestDataBuilder, TestEnvironment } from './TestInfrastructure';

describe('Test Infrastructure Validation', () => {
  it('should validate test infrastructure setup', async () => {
    // Test that our test infrastructure can be imported
    expect(TestEnvironment).toBeDefined();
    expect(TestDataBuilder).toBeDefined();
    expect(DatabaseTestRegistry).toBeDefined();
  });

  it('should create and cleanup test environment', async () => {
    let testEnv: TestEnvironment | null = null;

    try {
      // Create test environment
      testEnv = await TestEnvironment.create('infrastructure-test', {
        isolation: 'integration',
        useRealDatabase: false, // Use mock for infrastructure test
        testData: {
          entities: 1,
          memories: 2,
          messages: 3,
          relationships: 1,
        },
      });

      expect(testEnv).toBeDefined();
      expect(testEnv.testRuntime).toBeDefined();
      expect(testEnv.testDatabase).toBeDefined();

      console.log('✅ Test infrastructure validation passed');
    } finally {
      // Cleanup
      if (testEnv) {
        await testEnv.teardown();
      }
    }
  }, 30000); // 30 second timeout for database setup

  it('should validate performance measurement', async () => {
    let testEnv: TestEnvironment | null = null;

    try {
      testEnv = await TestEnvironment.create('performance-test', {
        useRealDatabase: false,
        performanceThresholds: {
          actionExecution: 1000,
          memoryRetrieval: 500,
          databaseQuery: 200,
          modelInference: 2000,
        },
      });

      // Test performance measurement
      const result = await testEnv.measurePerformance(
        async () => {
          // Simulate work
          await new Promise((resolve) => setTimeout(resolve, 100));
          return 'test-result';
        },
        'actionExecution',
        'Test operation'
      );

      expect(result).toBe('test-result');
      console.log('✅ Performance measurement validation passed');
    } finally {
      if (testEnv) {
        await testEnv.teardown();
      }
    }
  });
});
