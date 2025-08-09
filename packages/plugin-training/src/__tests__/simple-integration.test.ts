import { describe, it, expect } from 'bun:test';
import { TogetherAIClient } from '../lib/together-client.js';
import { DatasetBuilder } from '../lib/dataset-builder.js';

// Simplified TestSuite implementation for local use
class TestSuite {
  constructor(
    private name: string,
    private config: any
  ) {}

  addTest(test: any) {
    it(test.name, async () => {
      const context = this.config.beforeEach ? this.config.beforeEach() : {};
      await test.fn(context);
    });
  }

  run() {
    // No-op, bun:test handles execution
  }
}

const createUnitTest = (config: { name: string; fn: (context?: any) => Promise<void> | void }) =>
  config;

describe('Simple Integration Tests', () => {
  const simpleIntegrationSuite = new TestSuite('Simple Integration Tests', {});

  simpleIntegrationSuite.addTest(
    createUnitTest({
      name: 'should create TogetherAI client with API key',
      fn: () => {
        const client = new TogetherAIClient('test-api-key');
        expect(client).toBeDefined();
      },
    })
  );

  simpleIntegrationSuite.addTest(
    createUnitTest({
      name: 'should throw error without API key',
      fn: () => {
        expect(() => new TogetherAIClient('')).toThrow('Together.ai API key is required');
      },
    })
  );

  simpleIntegrationSuite.addTest(
    createUnitTest({
      name: 'should create dataset builder',
      fn: () => {
        const builder = new DatasetBuilder('./test-data');
        expect(builder).toBeDefined();
      },
    })
  );

  simpleIntegrationSuite.addTest(
    createUnitTest({
      name: 'should calculate correct token estimates',
      fn: () => {
        const builder = new DatasetBuilder('./test-data');
        // @ts-expect-error - accessing private method for testing
        const tokens = builder.estimateTokens('Hello world!');
        expect(tokens).toBeGreaterThan(0);
        expect(tokens).toBeLessThan(10);
      },
    })
  );

  simpleIntegrationSuite.addTest(
    createUnitTest({
      name: 'should handle empty examples gracefully',
      fn: async () => {
        const builder = new DatasetBuilder('./test-empty');
        await builder.loadExamples();

        const stats = builder.getStats();
        expect(stats.totalExamples).toBe(0);
        expect(stats.averageQuality).toBe(0);
        expect(stats.tokenCount).toBe(0);
      },
    })
  );

  simpleIntegrationSuite.run();
});
