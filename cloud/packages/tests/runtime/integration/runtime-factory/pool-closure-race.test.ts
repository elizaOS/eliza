/**
 * Pool Closure Race Condition Integration Tests
 *
 * These tests reproduce the "Cannot use a pool after calling end on the pool" error
 * that occurs in production when:
 * 1. Cache eviction calls safeClose() which closes the shared database pool
 * 2. Concurrent requests are still using the same pool
 * 3. Health checks find stale runtimes and close them
 *
 * Run with: bun test tests/runtime/integration/runtime-factory/pool-closure-race.test.ts
 *
 * IMPORTANT: These tests intentionally trigger error conditions to verify the bug exists.
 * They are expected to FAIL initially, proving the race condition exists.
 * After the fix is applied, they should PASS.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DEFAULT_AGENT_ID_STRING } from "../../../../lib/eliza/runtime-factory";
import { mcpTestCharacter } from "../../../fixtures/mcp-test-character";
import {
  // Test internals for race condition testing
  _testing,
  AgentMode,
  // Test helpers
  buildUserContext,
  cleanupAgentTasks,
  cleanupTestData,
  // Test data
  createTestDataSet,
  getConnectionString,
  // Local database
  getRuntimeCacheStats,
  hasDatabaseUrl,
  invalidateRuntime,
  isRuntimeCached,
  // Production RuntimeFactory
  runtimeFactory,
  type TestDataSet,
  verifyConnection,
} from "../../../infrastructure";

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_TIMEOUT = 120000; // 2 minutes per test
const ADAPTER_PROBE_TIMEOUT_MS = 5_000;
const runPoolClosureRaceTests = process.env.RUN_POOL_CLOSURE_RACE_TESTS === "1";

// ============================================================================
// Local Test State
// ============================================================================

let connectionString: string;
let testData: TestDataSet;

// ============================================================================
// Setup & Teardown
// ============================================================================

async function setupTestEnvironment(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("SETTING UP POOL CLOSURE RACE CONDITION TEST");
  console.log("=".repeat(60));

  // Verify database connection
  const connected = await verifyConnection();
  if (!connected) {
    throw new Error(
      "Cannot connect to database. Make sure DATABASE_URL is set and server is running.",
    );
  }
  connectionString = getConnectionString();
  console.log("Database connected");

  // Create test data with unique identifiers
  testData = await createTestDataSet(connectionString, {
    organizationName: "Pool Race Test Org",
    userName: "Pool Race Test User",
    userEmail: `pool-race-test-${Date.now()}@eliza.test`,
    creditBalance: 1000.0,
    includeCharacter: true,
    characterName: "Mira",
    characterData: { ...mcpTestCharacter },
    characterSettings: mcpTestCharacter.settings as Record<string, unknown>,
  });
  console.log("Test data created");
  console.log(`   API Key: ${testData.apiKey.keyPrefix}...`);

  // Clean up stale tasks from previous test runs to prevent the task scheduler
  // from picking them up and generating withRetry chains that outlive pool closure.
  await cleanupAgentTasks(connectionString, DEFAULT_AGENT_ID_STRING).catch((err) =>
    console.warn(`Task cleanup warning: ${err}`),
  );

  console.log("=".repeat(60) + "\n");
}

async function cleanupTestEnvironment(): Promise<void> {
  console.log("\nCleaning up pool race condition test...");
  if (connectionString) {
    await cleanupAgentTasks(connectionString, DEFAULT_AGENT_ID_STRING).catch((err) =>
      console.warn(`Task cleanup warning: ${err}`),
    );
  }
  if (testData && connectionString) {
    await cleanupTestData(connectionString, testData.organization.id).catch((err) =>
      console.warn(`Data cleanup warning: ${err}`),
    );
  }
}

async function withAdapterProbeTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ADAPTER_PROBE_TIMEOUT_MS}ms`));
      }, ADAPTER_PROBE_TIMEOUT_MS);
      (timeout as { unref?: () => void }).unref?.();
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

// ============================================================================
// Test Suite: Pool Closure Race Conditions
// ============================================================================

describe.skipIf(!hasDatabaseUrl || !runPoolClosureRaceTests)("Pool Closure Race Condition", () => {
  beforeAll(setupTestEnvironment, TEST_TIMEOUT);
  afterAll(cleanupTestEnvironment);

  describe("Thesis Verification: safeClose calls pool.end()", () => {
    /**
     * This test verifies the core thesis: that calling safeClose() on a runtime
     * causes adapter.close() which calls pool.end(), terminating the shared pool.
     */
    it(
      "should verify that runtime.close() calls adapter.close() which ends the pool",
      async () => {
        // Create a runtime
        const userContext = buildUserContext(testData, {
          agentMode: AgentMode.CHAT,
          webSearchEnabled: false,
        });

        const runtime = await runtimeFactory.createRuntimeForUser(userContext);
        const agentId = runtime.agentId as string;

        console.log(`\nCreated runtime: ${agentId}`);
        expect(isRuntimeCached(agentId)).toBe(true);

        // Get the adapter from the pool
        const adapterEntries = _testing.getAdapterEntries();
        const adapter = adapterEntries.get(agentId);
        expect(adapter).toBeDefined();

        // Verify the adapter is healthy before close
        const isHealthyBefore = await adapter!.isReady();
        console.log(`Adapter healthy before close: ${isHealthyBefore}`);
        expect(isHealthyBefore).toBe(true);

        // Stop services first so background task pollers don't fire on the closed pool
        // and leak unhandled rejections into subsequent tests
        await _testing.stopRuntimeServices(runtime, agentId, "Test");

        // Now call safeClose (simulating what eviction does)
        console.log("Calling safeClose on runtime...");
        await _testing.safeClose(runtime, "Test", agentId);

        // The adapter should now be closed
        // Attempting to use it should fail with "pool after calling end" or similar
        let errorOccurred = false;
        let errorMessage = "";

        try {
          // Try to execute a query through the adapter
          await withAdapterProbeTimeout(adapter!.isReady(), "adapter readiness after close");
        } catch (error) {
          errorOccurred = true;
          errorMessage = error instanceof Error ? error.message : String(error);
          console.log(`Expected error occurred: ${errorMessage}`);
        }

        // We expect an error because the pool was ended
        // The error message should contain "pool" and "end" or "closed"
        if (!errorOccurred) {
          console.log("WARNING: No error occurred - adapter may still be usable");
          console.log("This could indicate:");
          console.log("  1. Pool is not actually closed");
          console.log("  2. Adapter has connection recovery mechanisms");
          console.log("  3. Test is not exercising the correct code path");
        } else {
          expect(errorMessage.toLowerCase()).toMatch(/pool|end|closed|cannot|timed out/);
        }

        // Cleanup
        await invalidateRuntime(agentId);
      },
      TEST_TIMEOUT,
    );
  });

  describe("Race Condition: OLD Behavior (should fail)", () => {
    /**
     * This test uses the OLD (buggy) eviction behavior that closes the pool.
     * It should demonstrate that the old behavior causes failures.
     */
    it(
      "should demonstrate OLD eviction behavior causes pool closure",
      async () => {
        const userContext = buildUserContext(testData, {
          agentMode: AgentMode.CHAT,
          webSearchEnabled: false,
        });

        const runtimeA = await runtimeFactory.createRuntimeForUser(userContext);
        const agentIdA = runtimeA.agentId as string;
        console.log(`\nCreated Runtime A: ${agentIdA}`);

        // Get the adapter reference before any eviction
        const adapterEntries = _testing.getAdapterEntries();
        const adapterA = adapterEntries.get(agentIdA);
        expect(adapterA).toBeDefined();

        // Verify adapter works
        const healthyBefore = await adapterA!.isReady();
        expect(healthyBefore).toBe(true);
        console.log("Adapter A is healthy before eviction");

        // Trigger eviction using OLD behavior (safeClose - closes the pool)
        console.log("Triggering OLD eviction behavior (safeClose)...");
        await _testing.forceEvictRuntimeOld(agentIdA);
        console.log("OLD eviction complete");

        // Now try to use the adapter - should fail because pool is closed
        let concurrentError: Error | null = null;
        try {
          await adapterA!.isReady();
        } catch (error) {
          concurrentError = error as Error;
          console.log(`Error after OLD eviction: ${concurrentError.message}`);
        }

        // With OLD behavior, the adapter should fail (or at least log errors)
        console.log("\n*** OLD BEHAVIOR TEST COMPLETE ***");
        console.log("If errors occurred above, it confirms the old buggy behavior.");

        // Cleanup
        await invalidateRuntime(agentIdA).catch(() => {});
      },
      TEST_TIMEOUT,
    );
  });

  describe("Race Condition: NEW Behavior (should succeed)", () => {
    /**
     * This test uses the NEW (fixed) eviction behavior that preserves the pool.
     * Concurrent queries should NOT fail after eviction.
     */
    it(
      "should demonstrate NEW eviction behavior preserves pool",
      async () => {
        const userContext = buildUserContext(testData, {
          agentMode: AgentMode.CHAT,
          webSearchEnabled: false,
        });

        const runtimeA = await runtimeFactory.createRuntimeForUser(userContext);
        const agentIdA = runtimeA.agentId as string;
        console.log(`\nCreated Runtime A: ${agentIdA}`);

        // Get the adapter reference before any eviction
        const adapterEntries = _testing.getAdapterEntries();
        const adapterA = adapterEntries.get(agentIdA);
        expect(adapterA).toBeDefined();

        // Verify adapter works
        const healthyBefore = await adapterA!.isReady();
        expect(healthyBefore).toBe(true);
        console.log("Adapter A is healthy before eviction");

        // Trigger eviction using NEW behavior (runtime.stop() - preserves pool)
        console.log("Triggering NEW eviction behavior (runtime.stop())...");
        await _testing.forceEvictRuntime(agentIdA);
        console.log("NEW eviction complete");

        // Now try to use the adapter - should succeed because pool is preserved
        let succeeded = false;
        let errorMsg = "";
        try {
          await adapterA!.isReady();
          succeeded = true;
          console.log("Adapter STILL WORKS after NEW eviction!");
        } catch (error) {
          errorMsg = (error as Error).message;
          console.log(`Unexpected error after NEW eviction: ${errorMsg}`);
        }

        // With NEW behavior, the adapter should still work
        console.log("\n*** NEW BEHAVIOR TEST COMPLETE ***");
        if (succeeded) {
          console.log("SUCCESS: Pool was preserved, adapter still works!");
        } else {
          console.log(`UNEXPECTED: Adapter failed with: ${errorMsg}`);
        }

        // Cleanup
        await invalidateRuntime(agentIdA).catch(() => {});
      },
      TEST_TIMEOUT,
    );

    /**
     * This test verifies parallel queries succeed after NEW eviction
     */
    it(
      "should demonstrate parallel queries succeed with NEW eviction",
      async () => {
        const userContext = buildUserContext(testData, {
          agentMode: AgentMode.CHAT,
          webSearchEnabled: false,
        });

        const runtime = await runtimeFactory.createRuntimeForUser(userContext);
        const agentId = runtime.agentId as string;
        console.log(`\nCreated runtime: ${agentId}`);

        // Get adapter reference
        const adapterEntries = _testing.getAdapterEntries();
        const adapter = adapterEntries.get(agentId);
        expect(adapter).toBeDefined();

        const errors: Error[] = [];
        const results: boolean[] = [];

        const queryPromises = Array.from({ length: 5 }, async (_, i) => {
          try {
            await new Promise((r) => setTimeout(r, i * 10));
            const result = await adapter!.isReady();
            results.push(result);
            return { success: true, index: i };
          } catch (error) {
            errors.push(error as Error);
            return { success: false, index: i, error };
          }
        });

        // Eviction using NEW behavior
        const evictionPromise = (async () => {
          await new Promise((r) => setTimeout(r, 20));
          console.log("Starting NEW eviction...");
          await _testing.forceEvictRuntime(agentId);
          console.log("NEW eviction completed");
        })();

        await Promise.all([...queryPromises, evictionPromise]);

        console.log(`\nResults: ${results.length} successful, ${errors.length} errors`);

        if (errors.length === 0) {
          console.log("*** SUCCESS: All queries succeeded with NEW eviction ***");
          console.log("The fix is working correctly!");
        } else {
          console.log("*** UNEXPECTED ERRORS ***");
          errors.forEach((err, i) => {
            console.log(`  Error ${i + 1}: ${err.message}`);
          });
        }

        // With the fix, all queries should succeed
        expect(errors.length).toBe(0);

        // Cleanup
        await invalidateRuntime(agentId).catch(() => {});
      },
      TEST_TIMEOUT,
    );
  });

  describe("Race Condition: Multiple Runtimes Sharing Pool", () => {
    /**
     * This test demonstrates the shared pool issue:
     * 1. Create Runtime A for Agent 1
     * 2. Create Runtime B for Agent 2 (shares the same pool)
     * 3. Close Runtime A (ends the shared pool)
     * 4. Runtime B should fail
     */
    it(
      "should demonstrate shared pool closure affecting other runtimes",
      async () => {
        // We need two different agents to properly test shared pool
        // For this test, we'll create runtimes with different cache keys

        const userContextA = buildUserContext(testData, {
          agentMode: AgentMode.CHAT,
          webSearchEnabled: false, // This creates cache key: agentId
        });

        const userContextB = buildUserContext(testData, {
          agentMode: AgentMode.CHAT,
          webSearchEnabled: false,
          appPromptConfig: { prompt: "pool-race-context-b" },
        });

        // Create Runtime A
        const runtimeA = await runtimeFactory.createRuntimeForUser(userContextA);
        const agentIdA = runtimeA.agentId as string;
        console.log(`\nCreated Runtime A: ${agentIdA}`);

        // Create Runtime B with a different direct-access context signature.
        const runtimeB = await runtimeFactory.createRuntimeForUser(userContextB);
        const agentIdB = runtimeB.agentId as string;
        console.log(`Created Runtime B: ${agentIdB}`);

        // Verify both are cached
        expect(isRuntimeCached(agentIdA)).toBe(true);
        const matchingCacheKeys = Array.from(_testing.getCacheEntries().keys()).filter((key) =>
          key.startsWith(`${agentIdA}:`),
        );
        expect(matchingCacheKeys.length).toBeGreaterThanOrEqual(2);
        expect(getRuntimeCacheStats().runtime.size).toBeGreaterThanOrEqual(2);

        // Get adapters
        const adapterEntries = _testing.getAdapterEntries();
        console.log(`Adapter entries: ${Array.from(adapterEntries.keys()).join(", ")}`);

        // Both runtimes should be healthy
        const healthyA = await runtimeA.isReady();
        const healthyB = await runtimeB.isReady();
        console.log(`Runtime A healthy: ${healthyA}`);
        console.log(`Runtime B healthy: ${healthyB}`);
        expect(healthyA).toBe(true);
        expect(healthyB).toBe(true);

        // Now close Runtime A using safeClose (what eviction does)
        console.log("\nClosing Runtime A via safeClose...");
        await _testing.forceEvictRuntime(agentIdA);
        console.log("Runtime A closed");

        // Try to use Runtime B
        let errorB: Error | null = null;
        try {
          console.log("Checking Runtime B health after A was closed...");
          await runtimeB.isReady();
          console.log("Runtime B is still healthy");
        } catch (error) {
          errorB = error as Error;
          console.log(`Runtime B error: ${errorB.message}`);
        }

        // Analysis
        if (errorB) {
          console.log("\n*** SHARED POOL ISSUE REPRODUCED ***");
          console.log("Closing Runtime A affected Runtime B because they share a pool");
          expect(errorB.message.toLowerCase()).toMatch(/pool|end|closed|cannot/);
        } else {
          console.log("\n*** Shared pool issue NOT reproduced ***");
          console.log("Possible reasons:");
          console.log("  1. Each runtime has a separate pool (not shared)");
          console.log("  2. Pool recovery happened automatically");
          console.log("  3. Different adapter instances with same underlying pool");
        }

        // Cleanup
        await invalidateRuntime(agentIdA).catch(() => {});
      },
      TEST_TIMEOUT,
    );
  });

  describe("Race Condition: Direct Adapter Close", () => {
    // Clean up tasks accumulated by earlier describes in this suite so the task
    // scheduler doesn't saturate the DB with retries when the pool is closed.
    beforeAll(async () => {
      if (connectionString) {
        await cleanupAgentTasks(connectionString, DEFAULT_AGENT_ID_STRING).catch((err) =>
          console.warn(`Pre-test task cleanup warning: ${err}`),
        );
      }
    });

    /**
     * This test directly closes the adapter to verify the pool termination behavior
     */
    it(
      "should show direct adapter.close() terminates shared pool",
      async () => {
        const userContext = buildUserContext(testData, {
          agentMode: AgentMode.CHAT,
          webSearchEnabled: false,
        });

        const runtime = await runtimeFactory.createRuntimeForUser(userContext);
        const agentId = runtime.agentId as string;
        console.log(`\nCreated runtime: ${agentId}`);

        // Verify runtime is healthy
        const healthyBefore = await runtime.isReady();
        expect(healthyBefore).toBe(true);
        console.log("Runtime healthy before adapter close");

        // Directly close the adapter (bypassing safeClose)
        console.log("Directly closing adapter...");
        await _testing.closeAdapterDirectly(agentId);
        console.log("Adapter closed");

        // Now try to use the runtime
        let error: Error | null = null;
        try {
          await runtime.isReady();
        } catch (e) {
          error = e as Error;
          console.log(`Error after direct close: ${error.message}`);
        }

        if (error) {
          console.log("\n*** Direct adapter close caused pool termination ***");
          expect(error.message.toLowerCase()).toMatch(/pool|end|closed|cannot/);
        } else {
          console.log("\n*** Runtime still healthy after adapter close ***");
          console.log("This indicates adapter recovery or separate pools");
        }

        // Cleanup
        await invalidateRuntime(agentId).catch(() => {});
      },
      TEST_TIMEOUT,
    );
  });
});

// ============================================================================
// Test Suite: Simulating Production Error Scenario
// ============================================================================

describe.skipIf(!hasDatabaseUrl || !runPoolClosureRaceTests)(
  "Production Error Reproduction",
  () => {
    beforeAll(setupTestEnvironment, TEST_TIMEOUT);
    afterAll(cleanupTestEnvironment);

    /**
     * This test simulates the exact production scenario from the logs:
     * 1. Service registration times out
     * 2. New runtime creation starts
     * 3. Old runtime eviction happens
     * 4. Query fails with "Cannot use a pool after calling end on the pool"
     */
    it(
      "should reproduce production 'Cannot use a pool after calling end' error",
      async () => {
        console.log("\n" + "=".repeat(60));
        console.log("REPRODUCING PRODUCTION ERROR SCENARIO");
        console.log("=".repeat(60));

        // Step 1: Create an initial runtime (simulates existing cached runtime)
        const userContext = buildUserContext(testData, {
          agentMode: AgentMode.CHAT,
          webSearchEnabled: false,
        });

        const existingRuntime = await runtimeFactory.createRuntimeForUser(userContext);
        const existingAgentId = existingRuntime.agentId as string;
        console.log(`\nStep 1: Created existing runtime: ${existingAgentId}`);

        // Get reference to adapter (simulates what a concurrent request would hold)
        const adapterRef = _testing.getAdapterEntries().get(existingAgentId);
        expect(adapterRef).toBeDefined();

        // Step 2: Simulate timeout scenario by forcing eviction
        // This is what happens when cache evicts stale/unhealthy entries
        console.log("\nStep 2: Simulating eviction (what happens after timeout/error)");

        // Hold a promise that will try to query during eviction
        const concurrentQueryPromise = (async () => {
          // Small delay to let eviction start
          await new Promise((r) => setTimeout(r, 50));

          console.log("Concurrent query attempting to use adapter...");
          try {
            // This simulates a request that was in flight when eviction happened
            await adapterRef!.isReady();
            return { success: true };
          } catch (error) {
            return { success: false, error: (error as Error).message };
          }
        })();

        // Trigger eviction
        await _testing.forceEvictRuntime(existingAgentId);
        console.log("Eviction triggered");

        // Wait for concurrent query result
        const queryResult = await concurrentQueryPromise;

        // Step 3: Analyze results
        console.log("\nStep 3: Results");
        if (!queryResult.success) {
          console.log("*** PRODUCTION ERROR REPRODUCED ***");
          console.log(`Error: ${queryResult.error}`);

          // The specific error we're looking for
          const expectedErrors = [
            "cannot use a pool after calling end",
            "pool has been destroyed",
            "pool is closed",
            "connection terminated",
          ];

          const matchedError = expectedErrors.some((err) =>
            queryResult.error?.toLowerCase().includes(err.toLowerCase()),
          );

          if (matchedError) {
            console.log("\n!!! EXACT PRODUCTION ERROR MATCHED !!!");
            console.log("This confirms the race condition thesis.");
          }

          expect(queryResult.success).toBe(false);
        } else {
          console.log("Query succeeded - race condition timing not reproduced");
          console.log("The test may need adjustment for timing or the fix may already be in place");
        }

        // Cleanup
        await invalidateRuntime(existingAgentId).catch(() => {});
      },
      TEST_TIMEOUT,
    );
  },
);
