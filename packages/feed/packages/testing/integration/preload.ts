/**
 * Preload file for integration tests
 *
 * This file is loaded before all integration tests to:
 * 1. Set up proper test environment
 * 2. Configure database for test isolation
 * 3. Set up graceful cleanup handlers
 * 4. Configure LLM timeouts for faster test failures
 *
 * @module testing/integration/preload
 */

import { setDefaultTimeout } from 'bun:test';

// Set test environment first (before any imports)
// Using bracket notation to bypass readonly property check
(process.env as Record<string, string>)['NODE_ENV'] = 'test';
(process.env as Record<string, string>)['BUN_ENV'] = 'test';

setDefaultTimeout(30000);

// Reduce LLM timeout for tests (30 seconds instead of default)
process.env.LLM_TIMEOUT_MS = '30000';

import { db } from '@feed/db';

/**
 * Global test lifecycle hooks for database isolation
 */

/**
 * Removes stale generation locks that may interfere with test execution.
 */
async function cleanupStaleLocks(): Promise<void> {
  const expiredLocks = await db.generationLock.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });

  if (expiredLocks.count > 0) {
    console.log(
      `[Test Preload] Cleaned up ${expiredLocks.count} expired generation locks`
    );
  }

  const testLocks = await db.generationLock.deleteMany({
    where: {
      OR: [
        { id: { contains: 'test' } },
        { lockedBy: { contains: 'test' } },
        {
          AND: [
            { lockedBy: { startsWith: 'serverless-' } },
            { lockedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) } },
          ],
        },
      ],
    },
  });

  if (testLocks.count > 0) {
    console.log(
      `[Test Preload] Cleaned up ${testLocks.count} test-related locks`
    );
  }
}

/**
 * Removes test data that may interfere with other tests.
 */
async function cleanupTestData(): Promise<void> {
  const testUsers = await db.user.deleteMany({
    where: {
      OR: [
        { username: { startsWith: 'test-' } },
        { username: { startsWith: 'lock-test-' } },
        { username: { startsWith: 'endpoint-lock-' } },
        { username: { contains: 'integration-test' } },
      ],
    },
  });

  if (testUsers.count > 0) {
    console.log(`[Test Preload] Cleaned up ${testUsers.count} test users`);
  }

  // Clean up test questions/markets created in previous runs
  const oldTestQuestions = await db.question.deleteMany({
    where: {
      AND: [
        { text: { startsWith: 'Integration test:' } },
        { createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } }, // older than 1 hour
      ],
    },
  });

  if (oldTestQuestions.count > 0) {
    console.log(
      `[Test Preload] Cleaned up ${oldTestQuestions.count} old test questions`
    );
  }

  const oldTestMarkets = await db.market.deleteMany({
    where: {
      AND: [
        { question: { startsWith: 'Integration test:' } },
        { createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
      ],
    },
  });

  if (oldTestMarkets.count > 0) {
    console.log(
      `[Test Preload] Cleaned up ${oldTestMarkets.count} old test markets`
    );
  }
}

// Global flag to track if database is available
let dbAvailable = false;

/**
 * Check if database is available
 */
export function isDatabaseAvailable(): boolean {
  return dbAvailable;
}

/**
 * Initialize test environment
 */
async function initializeTestEnvironment(): Promise<void> {
  console.log('[Test Preload] Initializing integration test environment...');

  // Verify database connection
  await db.$queryRaw`SELECT 1`;
  console.log('[Test Preload] ✅ Database connection verified');
  dbAvailable = true;

  // Clean up stale data from previous test runs
  await cleanupStaleLocks();
  await cleanupTestData();

  console.log('[Test Preload] Integration test environment ready');
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(): Promise<void> {
  console.log('[Test Preload] Shutting down test environment...');

  // Clean up any remaining test data
  await cleanupStaleLocks();

  // Disconnect database
  await db.$disconnect();
  console.log('[Test Preload] Database disconnected');
}

await initializeTestEnvironment();

// Register shutdown handlers
process.on('beforeExit', gracefulShutdown);
process.on('SIGINT', async () => {
  await gracefulShutdown();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await gracefulShutdown();
  process.exit(0);
});

// Export utilities for tests to use
export { cleanupStaleLocks, cleanupTestData };
