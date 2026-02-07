/**
 * Configuration Change Race Condition Tests
 *
 * These tests verify that runtime configuration changes (mode switches, plugin
 * changes) don't cause pool closure issues during:
 * - Long-running evaluator operations (like long-term-extraction)
 * - Knowledge service access
 * - Memory service operations
 * - Concurrent queries during invalidation
 *
 * Run with: bun test tests/runtime/integration/runtime-factory/config-change-race.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  // Local database
  getConnectionString,
  verifyConnection,
  // Test data
  createTestDataSet,
  cleanupTestData,
  type TestDataSet,
  // Production RuntimeFactory
  runtimeFactory,
  invalidateRuntime,
  isRuntimeCached,
  AgentMode,
  // Test helpers
  buildUserContext,
  createTestUser,
  sendTestMessage,
  type TestRuntime,
  _testing,
} from "../../../infrastructure";
import { mcpTestCharacter } from "../../../fixtures/mcp-test-character";

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_TIMEOUT = 180000; // 3 minutes per test

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
    throw new Error(
      "Cannot connect to database. Make sure DATABASE_URL is set.",
    );
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
    await cleanupTestData(connectionString, testData.organization.id).catch(
      (err) => console.warn(`Data cleanup warning: ${err}`),
    );
  }
}

// ============================================================================
// Test Suite: Mode Switching During Operations
// ============================================================================

describe("Mode Switching During Operations", () => {
  beforeAll(setupTestEnvironment, TEST_TIMEOUT);
  afterAll(cleanupTestEnvironment);

  /**
   * Simulates the scenario:
   * 1. Runtime created in ASSISTANT mode
   * 2. Long-running database operations start (simulating evaluator)
   * 3. Mode change triggers invalidation
   * 4. Operations should complete without pool closure errors
   */
  it(
    "should handle mode switch from ASSISTANT to CHAT during DB operations",
    async () => {
      console.log("\n=== MODE SWITCH TEST: ASSISTANT → CHAT ===");

      // Create ASSISTANT mode runtime
      const assistantContext = buildUserContext(testData, {
        agentMode: AgentMode.ASSISTANT,
        webSearchEnabled: false,
      });

      const assistantRuntime =
        await runtimeFactory.createRuntimeForUser(assistantContext);
      const agentId = assistantRuntime.agentId as string;
      console.log(`Created ASSISTANT runtime: ${agentId}`);

      // Get adapter reference to simulate evaluator holding a reference
      const adapterEntries = _testing.getAdapterEntries();
      const adapter = adapterEntries.get(agentId);
      expect(adapter).toBeDefined();

      // Simulate long-running evaluator operations
      const errors: string[] = [];
      const operations: Promise<void>[] = [];

      // Simulate multiple database operations like an evaluator would make
      const simulateEvaluatorOperations = async (
        label: string,
      ): Promise<void> => {
        try {
          console.log(`${label}: Starting simulated evaluator operations...`);

          // Simulate runtime.countMemories()
          await assistantRuntime
            .countMemories(
              "00000000-0000-0000-0000-000000000001" as any,
              false,
              "messages",
            )
            .catch(() => {}); // May fail if room doesn't exist, that's OK

          // Simulate runtime.getMemories()
          await assistantRuntime
            .getMemories({
              tableName: "messages",
              roomId: "00000000-0000-0000-0000-000000000001" as any,
              count: 10,
              unique: false,
            })
            .catch(() => {});

          // Simulate getAgents (a real DB query)
          const agents = await assistantRuntime.getAgents();
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

      // Trigger mode change (invalidation) while operations are running
      const invalidationPromise = (async () => {
        await new Promise((r) => setTimeout(r, 50)); // Let operations start
        console.log(
          "\n>>> Triggering invalidation (simulating mode switch) <<<",
        );
        await invalidateRuntime(agentId);
        console.log(">>> Invalidation complete <<<\n");
      })();

      // Wait for all operations and invalidation
      await Promise.all([...operations, invalidationPromise]);

      // Report results
      console.log(`\n=== MODE SWITCH RESULTS ===`);
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
        (err) =>
          err.toLowerCase().includes("pool") ||
          err.toLowerCase().includes("cannot use"),
      );
      expect(poolErrors.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  /**
   * Test rapid mode switching
   */
  it(
    "should handle rapid mode switches between CHAT and ASSISTANT",
    async () => {
      console.log("\n=== RAPID MODE SWITCH TEST ===");

      const errors: string[] = [];
      let runtime: TestRuntime | null = null;

      // Rapidly switch between modes while running queries
      for (let i = 0; i < 5; i++) {
        const mode = i % 2 === 0 ? AgentMode.CHAT : AgentMode.ASSISTANT;
        console.log(`\nSwitch ${i + 1}: Creating runtime in ${mode} mode`);

        try {
          const context = buildUserContext(testData, {
            agentMode: mode,
            webSearchEnabled: false,
          });

          // Create new runtime
          runtime = await runtimeFactory.createRuntimeForUser(context);

          // Run a query
          const agents = await runtime.getAgents();
          console.log(`  Query succeeded: ${agents.length} agents`);

          // Invalidate immediately
          await invalidateRuntime(runtime.agentId as string);
          console.log(`  Invalidated`);
        } catch (error) {
          const msg = (error as Error).message;
          errors.push(`Switch ${i + 1}: ${msg}`);
          console.log(`  ERROR: ${msg}`);
        }
      }

      console.log(`\n=== RAPID SWITCH RESULTS ===`);
      console.log(`Total errors: ${errors.length}`);

      if (errors.length > 0) {
        errors.forEach((e) => console.log(`  ${e}`));
      } else {
        console.log("SUCCESS: All rapid switches completed without errors!");
      }

      // No pool errors should occur
      const poolErrors = errors.filter(
        (err) =>
          err.toLowerCase().includes("pool") ||
          err.toLowerCase().includes("cannot use"),
      );
      expect(poolErrors.length).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

// ============================================================================
// Test Suite: Service Access During Invalidation
// ============================================================================

describe("Service Access During Invalidation", () => {
  beforeAll(setupTestEnvironment, TEST_TIMEOUT);
  afterAll(cleanupTestEnvironment);

  /**
   * Simulates knowledge service access during runtime invalidation
   */
  it(
    "should handle knowledge service access during invalidation",
    async () => {
      console.log("\n=== KNOWLEDGE SERVICE ACCESS TEST ===");

      const context = buildUserContext(testData, {
        agentMode: AgentMode.ASSISTANT,
        webSearchEnabled: false,
      });

      const runtime = await runtimeFactory.createRuntimeForUser(context);
      const agentId = runtime.agentId as string;
      console.log(`Created runtime: ${agentId}`);

      // Get knowledge service if available
      const knowledgeService = runtime.getService("knowledge");
      console.log(
        `Knowledge service: ${knowledgeService ? "available" : "not available"}`,
      );

      const errors: string[] = [];

      // Simulate service operations during invalidation
      const serviceOps = async (): Promise<void> => {
        for (let i = 0; i < 5; i++) {
          try {
            await new Promise((r) => setTimeout(r, i * 20));
            // Try to get service (should work even during invalidation)
            const svc = runtime.getService("knowledge");
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
        (err) =>
          err.toLowerCase().includes("pool") ||
          err.toLowerCase().includes("cannot use"),
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
        agentMode: AgentMode.ASSISTANT,
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
                "00000000-0000-0000-0000-000000000001" as any,
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
      const ops = [
        memoryOps("Stream1"),
        memoryOps("Stream2"),
        memoryOps("Stream3"),
      ];

      // Invalidation during operations
      const invalidation = async (): Promise<void> => {
        await new Promise((r) => setTimeout(r, 25));
        console.log(">>> Invalidating during memory ops <<<");
        await invalidateRuntime(agentId);
      };

      await Promise.all([...ops, invalidation()]);

      console.log(
        `\nResults: ${successes.length} successes, ${errors.length} errors`,
      );
      if (errors.length > 0) {
        errors.forEach((e) => console.log(`  ${e}`));
      } else {
        console.log("SUCCESS: All memory operations completed!");
      }

      // No pool errors with the fix
      const poolErrors = errors.filter(
        (err) =>
          err.toLowerCase().includes("pool") ||
          err.toLowerCase().includes("cannot use"),
      );
      expect(poolErrors.length).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

// ============================================================================
// Test Suite: Concurrent Configuration Changes
// ============================================================================

describe("Concurrent Configuration Changes", () => {
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
        agentMode: AgentMode.ASSISTANT,
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
        (err) =>
          err.toLowerCase().includes("pool") ||
          err.toLowerCase().includes("cannot use"),
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
      console.log("\n=== PLUGIN CONFIG CHANGE TEST ===");

      // Create runtime with web search (different config)
      const contextA = buildUserContext(testData, {
        agentMode: AgentMode.ASSISTANT,
        webSearchEnabled: false,
      });

      const contextB = buildUserContext(testData, {
        agentMode: AgentMode.ASSISTANT,
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
        (err) =>
          err.toLowerCase().includes("pool") ||
          err.toLowerCase().includes("cannot use"),
      );
      expect(poolErrors.length).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

// ============================================================================
// Test Suite: Long-Running Operation Simulation
// ============================================================================

describe("Long-Running Operation Simulation", () => {
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
        agentMode: AgentMode.ASSISTANT,
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
          await runtime
            .countMemories(testUser.roomId, false, "messages")
            .catch(() => {});
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
          await runtime
            .countMemories(testUser.roomId, false, "messages")
            .catch(() => {});
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
          (err) =>
            err.toLowerCase().includes("pool") ||
            err.toLowerCase().includes("cannot use"),
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
        (err) =>
          err.toLowerCase().includes("pool") ||
          err.toLowerCase().includes("cannot use"),
      );
      expect(poolErrors.length).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
