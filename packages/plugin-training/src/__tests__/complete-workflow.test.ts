import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import { DatasetBuilder } from '../lib/dataset-builder.js';
import { TogetherAIClient } from '../lib/together-client.js';

// Simplified TestSuite implementation for local use
class TestSuite {
  constructor(
    private name: string,
    private config: any
  ) {}

  addTest(test: any) {
    it(test.name, async () => {
      const context = this.config.beforeEach ? await this.config.beforeEach() : {};
      try {
        await test.fn(context);
      } finally {
        if (this.config.afterEach) {
          await this.config.afterEach(context);
        }
      }
    });
  }

  run() {
    // No-op, bun:test handles execution
  }
}

const createUnitTest = (config: { name: string; fn: (context?: any) => Promise<void> | void }) =>
  config;

describe('Complete Workflow Tests', () => {
  const testDataDir = './test-workflow-temp';

  const completeWorkflowSuite = new TestSuite('Complete Workflow Tests', {
    beforeEach: async () => {
      const builder = new DatasetBuilder(testDataDir);
      // Clean up any existing test data
      try {
        await fs.rm(testDataDir, { recursive: true });
      } catch {
        // Directory doesn't exist, that's fine
      }
      return { builder, testDataDir };
    },
    afterEach: async () => {
      // Clean up test data
      try {
        await fs.rm(testDataDir, { recursive: true });
      } catch {
        // Directory doesn't exist, that's fine
      }
    },
  });

  completeWorkflowSuite.addTest(
    createUnitTest({
      name: 'should complete full training data workflow',
      fn: async ({ builder, testDataDir }) => {
        await builder.loadExamples();

        // Step 1: Add multiple examples
        const examples = [
          {
            request: 'Create a Discord plugin for ElizaOS',
            response: "I'll create a comprehensive Discord plugin...",
            thinking: 'First, I need to understand Discord API integration...',
            quality: 0.9,
          },
          {
            request: 'Create a weather API integration',
            response: "Here's a weather plugin implementation...",
            thinking: 'This requires API key management and error handling...',
            quality: 0.8,
          },
          {
            request: 'Build a blockchain price tracker',
            response: "I'll implement a real-time price tracking system...",
            thinking: 'This needs WebSocket connections and state management...',
            quality: 0.95,
          },
        ];

        for (const example of examples) {
          await builder.addExample(example);
        }

        // Step 2: Verify examples are stored
        const allExamples = builder.listExamples();
        expect(allExamples).toHaveLength(3);

        // Step 3: Generate dataset with filtering
        const datasetPath = `${testDataDir}/training-dataset.jsonl`;
        await builder.generateJSONL({
          outputPath: datasetPath,
          minQuality: 0.8,
          includeThinking: true,
        });

        // Step 4: Validate dataset exists and is properly formatted
        const content = await fs.readFile(datasetPath, 'utf-8');
        const lines = content.trim().split('\n');
        expect(lines).toHaveLength(3); // All examples should pass quality filter

        // Step 5: Validate JSONL format
        const validation = await builder.validateJSONL(datasetPath);
        expect(validation.valid).toBe(true);
        expect(validation.errors).toHaveLength(0);

        // Step 6: Check each entry structure
        for (const line of lines) {
          const entry = JSON.parse(line);
          expect(entry.messages).toHaveLength(3); // system, user, assistant
          expect(entry.messages[0].role).toBe('system');
          expect(entry.messages[1].role).toBe('user');
          expect(entry.messages[2].role).toBe('assistant');
          expect(entry.messages[2].content).toContain('<thinking>');
        }

        // Step 7: Get statistics
        const stats = builder.getStats();
        expect(stats.totalExamples).toBe(3);
        expect(stats.averageQuality).toBeCloseTo(0.88, 2);
        expect(stats.tokenCount).toBeGreaterThan(50);
      },
    })
  );

  completeWorkflowSuite.addTest(
    createUnitTest({
      name: 'should handle quality filtering correctly',
      fn: async ({ builder, testDataDir }) => {
        await builder.loadExamples();

        // Add examples with different qualities
        await builder.addExample({
          request: 'Low quality example',
          response: 'Poor response',
          quality: 0.3,
        });

        await builder.addExample({
          request: 'High quality example',
          response: 'Excellent response with detailed implementation...',
          quality: 0.9,
        });

        // Generate dataset with quality filter
        const datasetPath = `${testDataDir}/filtered-dataset.jsonl`;
        await builder.generateJSONL({
          outputPath: datasetPath,
          minQuality: 0.5,
        });

        const content = await fs.readFile(datasetPath, 'utf-8');
        const lines = content.trim().split('\n');
        expect(lines).toHaveLength(1); // Only high quality example should pass

        const entry = JSON.parse(lines[0]);
        expect(entry.messages[1].content).toBe('High quality example');
      },
    })
  );

  completeWorkflowSuite.addTest(
    createUnitTest({
      name: 'should create TogetherAI client with proper configuration',
      fn: () => {
        // Test client creation
        expect(() => new TogetherAIClient('')).toThrow();

        const client = new TogetherAIClient('test-key');
        expect(client).toBeDefined();
      },
    })
  );

  completeWorkflowSuite.addTest(
    createUnitTest({
      name: 'should handle token limits properly',
      fn: async ({ builder, testDataDir }) => {
        await builder.loadExamples();

        // Add example with long content
        const longContent = 'Very long response content '.repeat(200); // ~5000+ characters
        await builder.addExample({
          request: 'Create something complex',
          response: longContent,
          quality: 0.8,
        });

        const datasetPath = `${testDataDir}/token-limited-dataset.jsonl`;

        // Should throw error when no examples pass token limit
        await expect(
          builder.generateJSONL({
            outputPath: datasetPath,
            maxTokens: 100, // Very low limit
          })
        ).rejects.toThrow('No examples passed token limit filter');
      },
    })
  );

  completeWorkflowSuite.addTest(
    createUnitTest({
      name: 'should persist data across sessions',
      fn: async ({ builder, testDataDir }) => {
        // Session 1: Add data
        await builder.loadExamples();
        await builder.addExample({
          request: 'Persistent example',
          response: 'This should persist',
          quality: 0.8,
        });

        // Session 2: Create new builder and load
        const builder2 = new DatasetBuilder(testDataDir);
        await builder2.loadExamples();

        const examples = builder2.listExamples();
        expect(examples).toHaveLength(1);
        expect(examples[0].request).toBe('Persistent example');
      },
    })
  );

  completeWorkflowSuite.run();
});
