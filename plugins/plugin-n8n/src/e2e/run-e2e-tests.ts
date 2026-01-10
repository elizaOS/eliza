#!/usr/bin/env node
import { AgentRuntime, elizaLogger } from '@elizaos/core';
import { pluginDynamic } from '../index.ts';
import path from 'path';
import fs from 'fs-extra';

// Import test suites
import basicTestSuite from './basic.ts';
import timePluginTestSuite from './plugin-creation-time.ts';
import astralPluginTestSuite from './plugin-creation-astral.ts';
import shellPluginTestSuite from './plugin-creation-shell.ts';

const logger = elizaLogger;

async function setupTestEnvironment() {
  // Create test database directory
  const testDbDir = path.join(process.cwd(), '.test-db');
  await fs.ensureDir(testDbDir);

  // Set up test environment variables
  process.env.SQLITE_FILE = path.join(testDbDir, 'test.db');

  return testDbDir;
}

async function cleanupTestEnvironment(testDbDir: string) {
  // Clean up test database
  try {
    await fs.remove(testDbDir);
  } catch (error) {
    logger.warn('Failed to clean up test database:', error);
  }
}

async function createTestRuntime(): Promise<AgentRuntime> {
  // Create a mock runtime with the necessary services
  const runtime = {
    services: new Map(),
    getSetting: (key: string) => {
      if (key === 'ANTHROPIC_API_KEY') return process.env.ANTHROPIC_API_KEY;
      if (key === 'PLUGIN_DATA_DIR') return path.join(process.cwd(), 'data');
      if (key === 'CLAUDE_MODEL') return process.env.CLAUDE_MODEL;
      return process.env[key];
    },
    initialize: async () => {
      // Initialize the plugin services
      if (pluginDynamic.services) {
        for (const ServiceClass of pluginDynamic.services) {
          // Use the static start method if available
          if ((ServiceClass as any).start) {
            const service = await (ServiceClass as any).start(runtime as any);
            runtime.services.set('plugin_creation', service);
          } else {
            const service = new (ServiceClass as any)(runtime as any);
            if (service.initialize) {
              await service.initialize(runtime as any);
            }
            runtime.services.set('plugin_creation', service);
          }
        }
      }
    },
    stop: async () => {
      // Stop all services
      for (const [, service] of runtime.services) {
        if (service.stop) {
          await service.stop();
        }
      }
    },
  } as any;

  await runtime.initialize();

  return runtime;
}

async function runTestSuite(runtime: AgentRuntime, suite: any) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Running Test Suite: ${suite.name}`);
  console.log(`Description: ${suite.description}`);
  console.log(`${'='.repeat(80)}\n`);

  let passed = 0;
  let failed = 0;

  for (const test of suite.tests) {
    console.log(`\n▶ Running test: ${test.name}`);
    console.log(`${'─'.repeat(60)}`);

    try {
      await test.fn(runtime);
      passed++;
      console.log(`✅ PASSED: ${test.name}`);
    } catch (error) {
      failed++;
      console.error(`❌ FAILED: ${test.name}`);
      console.error(`   Error: ${error.message}`);
      if (error.stack) {
        console.error(`   Stack: ${error.stack.split('\n').slice(1, 3).join('\n')}`);
      }
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Suite Results: ${passed} passed, ${failed} failed`);

  return { passed, failed };
}

async function main() {
  console.log('🚀 Starting E2E Tests for Plugin auton8n\n');

  // Check for API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  WARNING: ANTHROPIC_API_KEY not set!');
    console.warn('   Plugin creation tests will be skipped.');
    console.warn('   Set ANTHROPIC_API_KEY environment variable to run full tests.\n');
  }

  let testDbDir: string | null = null;
  let runtime: AgentRuntime | null = null;

  try {
    // Set up test environment
    testDbDir = await setupTestEnvironment();

    // Create runtime
    console.log('Setting up test runtime...');
    runtime = await createTestRuntime();
    console.log('✓ Test runtime created\n');

    // Run all test suites
    const testSuites = [
      basicTestSuite,
      timePluginTestSuite,
      astralPluginTestSuite,
      shellPluginTestSuite,
    ];

    let totalPassed = 0;
    let totalFailed = 0;

    for (const suite of testSuites) {
      const { passed, failed } = await runTestSuite(runtime, suite);
      totalPassed += passed;
      totalFailed += failed;
    }

    // Print final summary
    console.log(`\n${'='.repeat(80)}`);
    console.log('FINAL TEST RESULTS');
    console.log(`${'='.repeat(80)}`);
    console.log(`Total Tests: ${totalPassed + totalFailed}`);
    console.log(`✅ Passed: ${totalPassed}`);
    console.log(`❌ Failed: ${totalFailed}`);
    console.log(`${'='.repeat(80)}\n`);

    // Exit with appropriate code
    process.exit(totalFailed > 0 ? 1 : 0);
  } catch (error) {
    console.error('\n💥 Fatal error running tests:', error);
    process.exit(1);
  } finally {
    // Cleanup
    if (runtime) {
      try {
        await runtime.stop();
      } catch (error) {
        logger.warn('Failed to stop runtime:', error);
      }
    }

    if (testDbDir) {
      await cleanupTestEnvironment(testDbDir);
    }
  }
}

// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

// Run tests
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
