import { ProductionScenarioRunner } from './ProductionScenarioRunner.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '@elizaos/core';
import type { Scenario } from '../types.js';
import path from 'path';
import fs from 'fs/promises';

// Example production-ready scenario
const createProductionScenario = (): Scenario => ({
  id: 'prod-test-001',
  name: 'Production System Test',
  description: 'Tests real agent interactions with actual database and plugins',
  category: 'integration',
  tags: ['production', 'real-db', 'real-llm'],
  actors: [
    {
      id: uuidv4() as any,
      name: 'Alice',
      role: 'subject',
      bio: 'I am Alice, a curious user who asks questions',
      system: 'You are a helpful assistant who answers questions accurately and concisely.',
      plugins: ['sql', 'browserService'],
      settings: {
        voice: 'en-US-Neural2-F',
      },
      script: {
        steps: [
          {
            type: 'message',
            content: 'Hello! Can you help me understand how databases work?',
            critical: true,
          },
          {
            type: 'wait',
            waitTime: 2000,
          },
          {
            type: 'message',
            content: 'What is the difference between SQL and NoSQL databases?',
          },
          {
            type: 'wait',
            waitTime: 2000,
          },
          {
            type: 'message',
            content: 'Can you search for information about PostgreSQL features?',
          },
        ],
      },
    },
    {
      id: uuidv4() as any,
      name: 'Bob',
      role: 'subject',
      bio: 'I am Bob, a technical expert who provides detailed explanations',
      system: 'You are a database expert who provides clear and detailed technical explanations.',
      plugins: ['sql'],
      settings: {
        voice: 'en-US-Neural2-A',
      },
      script: {
        steps: [
          {
            type: 'wait',
            waitTime: 3000,
          },
          {
            type: 'message',
            content:
              'I noticed you are discussing databases. Let me add some context about ACID properties.',
          },
        ],
      },
    },
  ],
  setup: {
    roomType: 'group',
    roomName: 'Database Discussion Room',
    context: 'A technical discussion about database technologies',
  },
  execution: {
    maxDuration: 60000, // 1 minute
    maxSteps: 10,
    timeout: 30000,
  },
  verification: {
    rules: [
      {
        id: 'response-quality',
        type: 'llm',
        description: 'Agents should provide helpful and accurate responses',
        config: {
          criteria: 'Responses should be relevant and informative',
        },
      },
    ],
  },
  expectations: {
    messagePatterns: [
      {
        pattern: 'database|sql|query',
        flags: 'i',
      },
    ],
    responseTime: {
      max: 5000, // 5 seconds max response time
    },
  },
  benchmarks: {
    customMetrics: [
      {
        name: 'messages_per_second',
        threshold: 0.1, // At least 0.1 messages per second
      },
      {
        name: 'unique_words',
        threshold: 50, // At least 50 unique words in conversation
      },
    ],
  },
  roomId: uuidv4() as any,
});

async function loadScenariosFromDirectory(dir: string): Promise<Scenario[]> {
  const scenarios: Scenario[] = [];

  try {
    const files = await fs.readdir(dir);

    for (const file of files) {
      if (file.endsWith('.ts') || file.endsWith('.js')) {
        const filePath = path.join(dir, file);
        const module = await import(filePath);

        if (module.default && typeof module.default === 'object') {
          scenarios.push(module.default as Scenario);
        } else if (module.scenario && typeof module.scenario === 'object') {
          scenarios.push(module.scenario as Scenario);
        }
      }
    }
  } catch (error) {
    logger.warn(`Failed to load scenarios from ${dir}:`, error);
  }

  return scenarios;
}

export async function runProductionScenarios(
  options: {
    scenarioDir?: string;
    apiKeys?: Record<string, string>;
    databaseUrl?: string;
    modelProvider?: string;
  } = {}
) {
  logger.info('🚀 Starting Production Scenario Runner');

  // Set up API keys from environment or options
  const apiKeys: Record<string, string> = {};

  if (process.env.OPENAI_API_KEY || options.apiKeys?.OPENAI_API_KEY) {
    apiKeys.OPENAI_API_KEY = (process.env.OPENAI_API_KEY || options.apiKeys?.OPENAI_API_KEY)!;
  }

  if (process.env.ANTHROPIC_API_KEY || options.apiKeys?.ANTHROPIC_API_KEY) {
    apiKeys.ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY ||
      options.apiKeys?.ANTHROPIC_API_KEY)!;
  }

  // Add any additional API keys from options
  if (options.apiKeys) {
    Object.assign(apiKeys, options.apiKeys);
  }

  // Validate required API keys
  if (!apiKeys.OPENAI_API_KEY && !apiKeys.ANTHROPIC_API_KEY) {
    logger.error('❌ No API keys found. Please set OPENAI_API_KEY or ANTHROPIC_API_KEY');
    process.exit(1);
  }

  // Create runner with configuration
  const runner = new ProductionScenarioRunner({
    databaseUrl: options.databaseUrl || process.env.DATABASE_URL,
    apiKeys,
    enableMetrics: true,
    enableVerification: true,
    cleanupAfterRun: true,
  });

  // Load scenarios
  const scenarios: Scenario[] = [];

  // Add the example scenario
  scenarios.push(createProductionScenario());

  // Load scenarios from directory if provided
  if (options.scenarioDir) {
    const loadedScenarios = await loadScenariosFromDirectory(options.scenarioDir);
    scenarios.push(...loadedScenarios);
  }

  logger.info(`📋 Found ${scenarios.length} scenarios to run`);

  // Run all scenarios
  const results = [];
  let passed = 0;
  let failed = 0;
  let partial = 0;

  for (const scenario of scenarios) {
    try {
      logger.info(`\n${'='.repeat(60)}`);
      logger.info(`Running scenario: ${scenario.name}`);
      logger.info(`${'='.repeat(60)}\n`);

      const result = await runner.run(scenario);
      results.push(result);

      switch (result.status) {
        case 'passed':
          passed++;
          break;
        case 'failed':
          failed++;
          break;
        case 'partial':
          partial++;
          break;
      }
    } catch (error) {
      logger.error(`Fatal error running scenario ${scenario.name}:`, error);
      failed++;
    }
  }

  // Summary
  logger.info(`\n${'='.repeat(60)}`);
  logger.info('📊 FINAL RESULTS');
  logger.info(`${'='.repeat(60)}`);
  logger.info(`Total scenarios: ${scenarios.length}`);
  logger.info(`✅ Passed: ${passed}`);
  logger.info(`❌ Failed: ${failed}`);
  logger.info(`⚠️  Partial: ${partial}`);
  logger.info(`${'='.repeat(60)}\n`);

  // Write results to file
  const reportPath = path.join(process.cwd(), 'scenario-results.json');
  await fs.writeFile(reportPath, JSON.stringify(results, null, 2));
  logger.info(`📄 Results written to: ${reportPath}`);

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runProductionScenarios({
    scenarioDir: process.argv[2],
  }).catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
}
