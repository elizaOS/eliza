/**
 * Test Setup Helper
 *
 * Ensures consistent test environment setup across all test suites.
 * Handles database initialization, database readiness checks, and test isolation.
 */

import { db } from "@feed/db";

/**
 * Check if database is available and properly configured
 * Throws if database is not available (fail-fast)
 */
export async function ensureDatabaseReady(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL not set");
  }

  // Simple connection test using db.$queryRaw
  await db.$queryRaw`SELECT 1`;
  return true;
}

/**
 * Setup test environment
 * Call this in beforeAll() hooks for tests that need database
 *
 * @param options.skipDatabase - If true, skip database connection (for unit tests)
 */
export async function setupTestEnvironment(options?: {
  skipDatabase?: boolean;
}) {
  // For unit tests, skip database setup
  if (options?.skipDatabase) {
    return;
  }

  // Ensure DATABASE_URL is available
  if (!process.env.DATABASE_URL) {
    console.warn(
      "⚠️  DATABASE_URL not set - database-dependent tests will be skipped",
    );
    return;
  }

  // Check database readiness - will throw if not available (fail-fast)
  await ensureDatabaseReady();

  // Ensure database client is connected
  await db.$connect();
  console.log("✅ Test environment ready");
}

/**
 * Cleanup test environment
 * Call this in afterAll() hooks
 */
export async function cleanupTestEnvironment() {
  await db.$disconnect();
}

/**
 * Helper to check if tests should skip based on database availability
 */
export function shouldSkipDatabaseTests(): boolean {
  const hasDatabase = !!process.env.DATABASE_URL;
  const skipRequested = process.env.SKIP_DATABASE_TESTS === "true";

  return !hasDatabase || skipRequested;
}

/**
 * Clean up stale generation locks that might interfere with tests
 * Call this in beforeAll() or beforeEach() if your tests use locks
 */
export async function cleanupStaleLocks(): Promise<number> {
  // Delete expired locks
  const result = await db.generationLock.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        // Also clean up any locks from previous test runs
        { id: { contains: "test" } },
        { lockedBy: { contains: "test" } },
      ],
    },
  });
  return result.count;
}

/**
 * Generate a unique test ID to avoid conflicts between parallel tests
 */
export function generateTestId(prefix = "test"): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Create an isolated test context with automatic cleanup
 * Use this for tests that create database records
 *
 * @example
 * ```typescript
 * const { cleanup, testPrefix } = await createIsolatedTestContext('my-test');
 * // Create records with testPrefix in their IDs
 * // ...
 * // In afterAll:
 * await cleanup();
 * ```
 */
export async function createIsolatedTestContext(name: string): Promise<{
  testPrefix: string;
  cleanup: () => Promise<void>;
}> {
  const testPrefix = generateTestId(name);

  const cleanup = async () => {
    // Clean up any records created with this test prefix
    await db.generationLock.deleteMany({
      where: {
        OR: [
          { id: { contains: testPrefix } },
          { lockedBy: { contains: testPrefix } },
        ],
      },
    });

    await db.user.deleteMany({
      where: {
        OR: [
          { username: { contains: testPrefix } },
          { id: { contains: testPrefix } },
        ],
      },
    });
  };

  return { testPrefix, cleanup };
}

/**
 * Wrap a test operation in a timeout to prevent hanging
 * Useful for tests that call external services
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  operationName = "operation",
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([operation, timeoutPromise]);
}
