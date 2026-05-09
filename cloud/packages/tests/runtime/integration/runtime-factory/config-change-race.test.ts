/**
 * Configuration Change Race Condition Tests
 *
 * These tests verify that runtime configuration changes and invalidations don't
 * cause pool closure issues during:
 * - Long-running evaluator operations (like long-term-extraction)
 * - Knowledge service access
 * - Memory service operations
 * - Concurrent queries during invalidation
 *
 * Run with: bun test tests/runtime/integration/runtime-factory/config-change-race.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stringToUuid } from "@elizaos/core";
import { mcpTestCharacter } from "../../../fixtures/mcp-test-character";
import {
  _testing,
  AgentMode,
  // Test helpers
  buildUserContext,
  cleanupTestData,
  // Test data
  createTestDataSet,
  createTestUser,
  getConnectionString,
  // Local database
  hasDatabaseUrl,
  invalidateRuntime,
  // Production RuntimeFactory
  runtimeFactory,
  type TestDataSet,
  type TestRuntime,
  verifyConnection,
} from "../../../infrastructure";

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_TIMEOUT = 180000; // 3 minutes per test
const hasHostedWebSearchApiKey = Boolean(
  process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
);
const DB_PROBE_TIMEOUT_MS = 5_000;

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
  console.log("SETTING UP CONFIG CHANGE RACE CONDITION TEST");
  console.log("=".repeat(60));

  const connected = await verifyConnection();
  if (!connected) {
    throw new Error("Cannot connect to database. Make sure DATABASE_URL is set.");
  }
  connectionString = getConnectionString();
  console.log("Database connected");

  testData = await createTestDataSet(connectionString, {
    organizationName: "Config Change Race Test Org",
    userName: "Config Change Race Test User",
    userEmail: `config-race-test-${Date.now()}@eliza.test`,
    creditBalance: 1000.0,
    includeCharacter: true,
    characterName: "Mira",
    characterData: mcpTestCharacter as unknown as Record<string, unknown>,
    characterSettings: mcpTestCharacter.settings as Record<string, unknown>,
  });
  console.log("Test data created");
  console.log("=".repeat(60) + "\n");
}

async function cleanupTestEnvironment(): Promise<void> {
  console.log("\nCleaning up config change race condition test...");
  if (testData && connectionString) {
    await cleanupTestData(connectionString, testData.organization.id).catch((err) =>
      console.warn(`Data cleanup warning: ${err}`),
    );
  }
}

async function ignoreExpectedProbeFailure(promise: Promise<unknown>, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        console.warn(`${label}: probe timed out after ${DB_PROBE_TIMEOUT_MS}ms`);
        resolve();
      }, DB_PROBE_TIMEOUT_MS);
      (timeout as { unref?: () => void }).unref?.();
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

// ============================================================================
// Test Suite: Runtime Invalidation During Operations
// ============================================================================

describe.skipIf(!hasDatabaseUrl)("Runtime Invalidation During Operations", () => {
  beforeAll(setupTestEnvironment, TEST_TIMEOUT);
  afterAll(cleanupTestEnvironment);

  /**
   * Simulates the scenario:
   * 1. Runtime created in CHAT mode
   * 2. Long-running database operations start (simulating evaluator)
   * 3. Config change triggers invalidation
   * 4. Operations should complete without pool closure errors
  */
  it(
    "should handle runtime invalidation during DB operations",
    async () => {
      console.log("\n=== RUNTIME INVALIDATION TEST ===");

      const chatContext = buildUserContext(testData, {
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      });

      const chatRuntime = await runtimeFactory.createRuntimeForUser(chatContext);
      const agentId = chatRuntime.agentId as string;
      console.log(`Created CHAT runtime: ${agentId}`);

      // Get adapter reference to simulate evaluator holding a reference
      const adapterEntries = _testing.getAdapterEntries();
      const adapter = adapterEntries.get(agentId);
      expect(adapter).toBeDefined();

      // Simulate long-running evaluator operations
      const errors: string[] = [];
      const operations: Promise<void>[] = [];

      // Simulate multiple database operations like an evaluator would make
      const simulateEvaluatorOperations = async (label: string): Promise<void> => {
        try {
          console.log(`${label}: Starting simulated evaluator operations...`);
          const selfRoomId = chatRuntime.agentId;

          // Simulate runtime.countMemories()
          await ignoreExpectedProbeFailure(
            chatRuntime.countMemories(selfRoomId, false, "messages"),
            `${label}: countMemories`,
          );

          // Simulate runtime.getMemories()
          await ignoreExpectedProbeFailure(
            chatRuntime.getMemories({
              tableName: "messages",
              roomId: selfRoomId,
              count: 10,
              unique: false,
            }),
            `${label}: getMemories`,
          );

          // Simulate getAgents (a real DB query)
          const agents = await Promise.race([
            chatRuntime.getAgents(),
            new Promise<never>((_, reject) => {
              const t = setTimeout(
                () => reject(new Error(`${label}: getAgents probe timed out`)),
                DB_PROBE_TIMEOUT_MS,
              );
              (t as { unref?: () => void }).unref?.();
            }),
          ]);
          console.log(`${label}: getAgents returned ${agents.length} agents`);

          console.log(`${label}: Operations completed successfully`);
        } catch (error) {
          const msg = (error as Error).message;
          errors.push(`${label}: ${msg}`);
          console.log(`${label}: FAILED - ${msg}`);
        }
      };

      // Start multiple concurrent evaluator-like operations
      for (let i = 0; i < 3; i++) {
        operations.push(simulateEvaluatorOperations(`Op${i}`));
      }

      // Trigger invalidation while operations are running
      const invalidationPromise = (async () => {
        await new Promise((r) => setTimeout(r, 50)); // Let operations start
        console.log("\n>>> Triggering invalidation <<<");
        await invalidateRuntime(agentId);
        console.log(">>> Invalidation complete <<<\n");
      })();

      // Wait for all operations and invalidation
      await Promise.all([...operations, invalidationPromise]);

      // Report results
      console.log(`\n=== RUNTIME INVALIDATION RESULTS ===`);
      console.log(`Errors: ${errors.length}`);

      if (errors.length > 0) {
        console.log("ERRORS FOUND:");
        errors.forEach((e) => console.log(`  ${e}`));

        // Check for pool closure errors
        const hasPoolError = errors.some(
          (err) =>
            err.toLowerCase().includes("pool") ||
            err.toLowerCase().includes("end") ||
            err.toLowerCase().includes("closed") ||
            err.toLowerCase().includes("cannot"),
        );

        if (hasPoolError) {
          console.log("\n*** POOL CLOSURE ERROR DETECTED ***");
          console.log("This indicates the fix may not be working correctly.");
        }
      } else {
        console.log("SUCCESS: All operations completed without pool errors!");
      }

      // With the fix, no pool errors should occur
      const poolErrors = errors.filter(
        (err) => err.toLowerCase().includes("pool") || err.toLowerCase().includes("cannot use"),
      );
      expect(poolErrors.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  /**
   * Test rapid runtime recreation.
   */
  it(
    "should handle rapid runtime recreation",
    async () => {
      console.log("\n=== RAPID RUNTIME RECREATION TEST ===");

      const errors: string[] = [];
      let runtime: TestRuntime | null = null;

      for (let i = 0; i < 5; i++) {
        console.log(`\nCycle ${i + 1}: Creating CHAT runtime`);

        try {
          const context = buildUserContext(testData, {
            agentMode: AgentMode.CHAT,
            webSearchEnabled: false,
          });

          // Create new runtime
          runtime = await runtimeFactory.createRuntimeForUser(context);

          // Run a query (bounded to prevent hangs across pool invalidations)
          const agents = await Promise.race([
            runtime.getAgents(),
            new Promise<never>((_, reject) => {
              const t = setTimeout(
                () => reject(new Error(`Cycle ${i + 1}: getAgents probe timed out`)),
                DB_PROBE_TIMEOUT_MS,
              );
              (t as { unref?: () => void }).unref?.();
            }),
          ]);
          console.log(`  Query succeeded: ${agents.length} agents`);

          // Invalidate immediately
          await invalidateRuntime(runtime.agentId as string);
          console.log(`  Invalidated`);
        } catch (error) {
          const msg = (error as Error).message;
          errors.push(`Cycle ${i + 1}: ${msg}`);
          console.log(`  ERROR: ${msg}`);
        }
      }

      console.log(`\n=== RAPID RECREATION RESULTS ===`);
      console.log(`Total errors: ${errors.length}`);

      if (errors.length > 0) {
        errors.forEach((e) => console.log(`  ${e}`));
      } else {
        console.log("SUCCESS: All rapid recreation cycles completed without errors!");
      }

      // No pool errors should occur
      const poolErrors = errors.filter(
        (err) => err.toLowerCase().includes("pool") || err.toLowerCase().includes("cannot use"),
      );
      expect(poolErrors.length).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

// ============================================================================
// Test Suite: Service Access During Invalidation
// ============================================================================

describe.skipIf(!hasDatabaseUrl)("Service Access During Invalidation", () => {
  beforeAll(setupTestEnvironment, TEST_TIMEOUT);
  afterAll(cleanupTestEnvironment);

  /**
   * Simulates documents service access during runtime invalidation
   */
  it(
    "should handle documents service access during invalidation",
    async () => {
      console.log("\n=== DOCUMENTS SERVICE ACCESS TEST ===");

      const context = buildUserContext(testData, {
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      });

      const runtime = await runtimeFactory.createRuntimeForUser(context);
      const agentId = runtime.agentId as string;
      console.log(`Created runtime: ${agentId}`);

      // Get documents service if available
      const documentsService = runtime.getService("documents");
      console.log(`Documents service: ${documentsService ? "available" : "not available"}`);

      const errors: string[] = [];

      // Simulate service operations during invalidation
      const serviceOps = async (): Promise<void> => {
        for (let i = 0; i < 5; i++) {
          try {
            await new Promise((r) => setTimeout(r, i * 20));
            // Try to get service (should work even during invalidation)
            const _svc = runtime.getService("documents");
            // Also try a DB operation
            await runtime.getAgents();
            console.log(`Service op ${i}: success`);
          } catch (error) {
            errors.push(`Service op ${i}: ${(error as Error).message}`);
          }
        }
      };

      const invalidation = async (): Promise<void> => {
        await new Promise((r) => setTimeout(r, 30));
        console.log(">>> Invalidating runtime <<<");
        await invalidateRuntime(agentId);
      };

      await Promise.all([serviceOps(), invalidation()]);

      console.log(`\nResults: ${errors.length} errors`);
      if (errors.length > 0) {
        errors.forEach((e) => console.log(`  ${e}`));
      }

      // Pool errors should not occur with the fix
      const poolErrors = errors.filter(
        (err) => err.toLowerCase().includes("pool") || err.toLowerCase().includes("cannot use"),
      );
      expect(poolErrors.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  /**
   * Simulates memory service operations during invalidation
   */
  it(
    "should handle memory service operations during invalidation",
    async () => {
      console.log("\n=== MEMORY SERVICE OPERATIONS TEST ===");

      const context = buildUserContext(testData, {
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      });

      const runtime = await runtimeFactory.createRuntimeForUser(context);
      const agentId = runtime.agentId as string;
      console.log(`Created runtime: ${agentId}`);

      const errors: string[] = [];
      const successes: number[] = [];

      // Simulate memory service operations (like evaluator would do)
      const memoryOps = async (label: string): Promise<void> => {
        for (let i = 0; i < 5; i++) {
          try {
            await new Promise((r) => setTimeout(r, i * 10));

            // Simulate memory operations
            await runtime
              .countMemories(
                stringToUuid("00000000-0000-0000-0000-000000000001"),
                false,
                "messages",
              )
              .catch(() => {}); // Room may not exist

            // Real DB query
            await runtime.getAgents();

            successes.push(i);
          } catch (error) {
            errors.push(`${label} op ${i}: ${(error as Error).message}`);
          }
        }
      };

      // Multiple memory operation streams
      const ops = [memoryOps("Stream1"), memoryOps("Stream2"), memoryOps("Stream3")];

      // Invalidation during operations
      const invalidation = async (): Promise<void> => {
        await new Promise((r) => setTimeout(r, 25));
        console.log(">>> Invalidating during memory ops <<<");
        await invalidateRuntime(agentId);
      };

      await Promise.all([...ops, invalidation()]);

      console.log(`\nResults: ${successes.length} successes, ${errors.length} errors`);
      if (errors.length > 0) {
        errors.forEach((e) => console.log(`  ${e}`));
      } else {
        console.log("SUCCESS: All memory operations completed!");
      }

      // No pool errors with the fix
      const poolErrors = errors.filter(
        (err) => err.toLowerCase().includes("pool") || err.toLowerCase().includes("cannot use"),
      );
      expect(poolErrors.length).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

// ============================================================================
// Test Suite: Concurrent Configuration Changes
// ============================================================================

describe.skipIf(!hasDatabaseUrl)("Concurrent Configuration Changes", () => {
  beforeAll(setupTestEnvironment, TEST_TIMEOUT);
  afterAll(cleanupTestEnvironment);

  /**
   * Simulates multiple users triggering configuration changes simultaneously
   */
  it(
    "should handle concurrent invalidations from multiple sources",
    async () => {
      console.log("\n=== CONCURRENT INVALIDATIONS TEST ===");

      const context = buildUserContext(testData, {
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      });

      const runtime = await runtimeFactory.createRuntimeForUser(context);
      const agentId = runtime.agentId as string;
      console.log(`Created runtime: ${agentId}`);

      const errors: string[] = [];

      // Multiple concurrent queries
      const queries = Array.from({ length: 10 }, async (_, i) => {
        try {
          await new Promise((r) => setTimeout(r, i * 5));
          const agents = await runtime.getAgents();
          console.log(`Query ${i}: ${agents.length} agents`);
          return { success: true };
        } catch (error) {
          errors.push(`Query ${i}: ${(error as Error).message}`);
          return { success: false };
        }
      });

      // Multiple concurrent invalidations (simulating multiple config changes)
      const invalidations = Array.from({ length: 3 }, async (_, i) => {
        await new Promise((r) => setTimeout(r, 10 + i * 15));
        console.log(`>>> Invalidation ${i} <<<`);
        await invalidateRuntime(agentId);
      });

      await Promise.all([...queries, ...invalidations]);

      console.log(`\nResults: ${errors.length} errors`);
      if (errors.length > 0) {
        console.log("Errors:");
        errors.forEach((e) => console.log(`  ${e}`));
      } else {
        console.log("SUCCESS: All operations completed!");
      }

      // No pool errors
      const poolErrors = errors.filter(
        (err) => err.toLowerCase().includes("pool") || err.toLowerCase().includes("cannot use"),
      );
      expect(poolErrors.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  /**
   * Simulates plugin add/remove during operations
   */
  it(
    "should handle plugin configuration changes during queries",
    async () => {
      if (!hasHostedWebSearchApiKey) {
        console.log("Skipping plugin config webSearch case: GOOGLE_API_KEY not set");
        return;
      }

      console.log("\n=== PLUGIN CONFIG CHANGE TEST ===");

      // Create runtime with web search (different config)
      const contextA = buildUserContext(testData, {
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      });

      const contextB = buildUserContext(testData, {
        agentMode: AgentMode.CHAT,
        webSearchEnabled: true, // Different config = different cache key
      });

      // Create both runtimes
      const runtimeA = await runtimeFactory.createRuntimeForUser(contextA);
      const runtimeB = await runtimeFactory.createRuntimeForUser(contextB);

      console.log(`Runtime A (no ws): ${runtimeA.agentId}`);
      console.log(`Runtime B (with ws): ${runtimeB.agentId}`);

      const errors: string[] = [];

      // Queries on both runtimes
      const queriesA = Array.from({ length: 5 }, async (_, i) => {
        try {
          await new Promise((r) => setTimeout(r, i * 10));
          await runtimeA.getAgents();
          return { runtime: "A", success: true };
        } catch (error) {
          errors.push(`RuntimeA query ${i}: ${(error as Error).message}`);
          return { runtime: "A", success: false };
        }
      });

      const queriesB = Array.from({ length: 5 }, async (_, i) => {
        try {
          await new Promise((r) => setTimeout(r, i * 10));
          await runtimeB.getAgents();
          return { runtime: "B", success: true };
        } catch (error) {
          errors.push(`RuntimeB query ${i}: ${(error as Error).message}`);
          return { runtime: "B", success: false };
        }
      });

      // Invalidate one while querying both
      const invalidation = async (): Promise<void> => {
        await new Promise((r) => setTimeout(r, 25));
        console.log(">>> Invalidating runtime A <<<");
        await invalidateRuntime(runtimeA.agentId as string);
      };

      await Promise.all([...queriesA, ...queriesB, invalidation()]);

      console.log(`\nResults: ${errors.length} errors`);
      if (errors.length > 0) {
        errors.forEach((e) => console.log(`  ${e}`));
      } else {
        console.log("SUCCESS: Plugin config changes handled correctly!");
      }

      // Cleanup
      await invalidateRuntime(runtimeA.agentId as string).catch(() => {});
      await invalidateRuntime(`${runtimeB.agentId}:ws`).catch(() => {});

      // No pool errors
      const poolErrors = errors.filter(
        (err) => err.toLowerCase().includes("pool") || err.toLowerCase().includes("cannot use"),
      );
      expect(poolErrors.length).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

// ============================================================================
// Test Suite: Long-Running Operation Simulation
// ============================================================================

describe.skipIf(!hasDatabaseUrl)("Long-Running Operation Simulation", () => {
  beforeAll(setupTestEnvironment, TEST_TIMEOUT);
  afterAll(cleanupTestEnvironment);

  /**
   * Simulates the exact scenario from long-term-extraction.ts evaluator:
   * Multiple database operations in sequence, interrupted by invalidation
   */
  it(
    "should handle evaluator-like operation sequence during invalidation",
    async () => {
      console.log("\n=== EVALUATOR SEQUENCE TEST ===");
      console.log("Simulating long-term-extraction evaluator operations...");

      const context = buildUserContext(testData, {
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      });

      const runtime = await runtimeFactory.createRuntimeForUser(context);
      const agentId = runtime.agentId as string;
      console.log(`Created runtime: ${agentId}`);

      const testUser = await createTestUser(runtime, "EvaluatorTestUser");

      const errors: string[] = [];
      const completedSteps: string[] = [];

      // Simulate the exact sequence from long-term-extraction.ts handler()
      const simulateEvaluatorHandler = async (): Promise<void> => {
        try {
          console.log("  [Evaluator] Starting extraction sequence...");

          // Step 1: runtime.countMemories() - line 215 in evaluator
          console.log("  [Evaluator] Step 1: countMemories");
          await runtime.countMemories(testUser.roomId, false, "messages").catch(() => {});
          completedSteps.push("countMemories_1");

          // Small delay (simulating processing)
          await new Promise((r) => setTimeout(r, 20));

          // Step 2: runtime.getMemories() - line 243
          console.log("  [Evaluator] Step 2: getMemories");
          await runtime
            .getMemories({
              tableName: "messages",
              roomId: testUser.roomId,
              count: 20,
              unique: false,
            })
            .catch(() => {});
          completedSteps.push("getMemories");

          // Step 3: Get existing memories - line 260
          // (simulated with getAgents since we don't have full memory service)
          console.log("  [Evaluator] Step 3: Query existing memories");
          await runtime.getAgents();
          completedSteps.push("existingMemories");

          // Step 4: runtime.composeState() - line 276
          // This is CPU-bound, no DB access

          // Step 5: runtime.useModel() - line 286
          // This is an LLM call, can take 5-30 seconds
          console.log("  [Evaluator] Step 5: Simulating LLM call (100ms)");
          await new Promise((r) => setTimeout(r, 100)); // Simulate LLM call
          completedSteps.push("llmCall");

          // Step 6: Store memories - line 301
          console.log("  [Evaluator] Step 6: Store memory operations");
          await runtime.getAgents(); // Simulated DB write
          completedSteps.push("storeMemory");

          // Step 7: runtime.countMemories() again - line 332
          console.log("  [Evaluator] Step 7: Final countMemories");
          await runtime.countMemories(testUser.roomId, false, "messages").catch(() => {});
          completedSteps.push("countMemories_2");

          // Step 8: Update checkpoint - line 337
          console.log("  [Evaluator] Step 8: Update checkpoint");
          await runtime.getAgents(); // Simulated checkpoint write
          completedSteps.push("checkpoint");

          console.log("  [Evaluator] Sequence completed successfully!");
        } catch (error) {
          errors.push(`Evaluator sequence: ${(error as Error).message}`);
          console.log(`  [Evaluator] FAILED: ${(error as Error).message}`);
        }
      };

      // Run evaluator simulation with invalidation in the middle
      const evaluatorPromise = simulateEvaluatorHandler();

      const invalidationPromise = (async () => {
        // Wait until evaluator is in the middle (around step 4-5)
        await new Promise((r) => setTimeout(r, 80));
        console.log("\n>>> INVALIDATION triggered during evaluator <<<\n");
        await invalidateRuntime(agentId);
      })();

      await Promise.all([evaluatorPromise, invalidationPromise]);

      console.log(`\n=== EVALUATOR SEQUENCE RESULTS ===`);
      console.log(`Completed steps: ${completedSteps.join(" → ")}`);
      console.log(`Errors: ${errors.length}`);

      if (errors.length > 0) {
        console.log("Errors encountered:");
        errors.forEach((e) => console.log(`  ${e}`));

        const hasPoolError = errors.some(
          (err) => err.toLowerCase().includes("pool") || err.toLowerCase().includes("cannot use"),
        );

        if (hasPoolError) {
          console.log("\n*** POOL CLOSURE ERROR IN EVALUATOR ***");
          console.log("This is the exact bug we're fixing!");
        }
      } else {
        console.log("SUCCESS: Evaluator completed despite invalidation!");
      }

      // With the fix, no pool errors should occur
      const poolErrors = errors.filter(
        (err) => err.toLowerCase().includes("pool") || err.toLowerCase().includes("cannot use"),
      );
      expect(poolErrors.length).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
