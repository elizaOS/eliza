/**
 * Performance - Runtime Creation Integration Tests
 *
 * Measures runtime performance for serverless optimization.
 * This is a self-contained test file with its own setup/teardown.
 *
 * Run with: bun test tests/runtime/integration/performance/runtime-creation.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import {
  AgentMode,
  cleanupTestData,
  // Test data
  createTestDataSet,
  // Test runtime
  createTestRuntime,
  createTestUser,
  getConnectionString,
  // Local database
  hasDatabaseUrl,
  type TestDataSet,
  type TestRuntimeResult,
  type TestUserContext,
  verifyConnection,
} from "../../../infrastructure";
import { HRTimer, TimingCollector } from "../../../infrastructure/timing";

const LOCAL_DB_QUERY_WARNING_MS = 500;
const LOCAL_DB_QUERY_TIMEOUT_MS = 5000;

// ============================================================================
// Runtime Creation Performance Tests
// ============================================================================

describe.skipIf(!hasDatabaseUrl)("Runtime Creation Performance", () => {
  // Local test state (isolated to this describe block)
  let connectionString: string;
  let testData: TestDataSet;
  const runtimes: TestRuntimeResult[] = [];
  const collector = new TimingCollector();

  beforeAll(async () => {
    console.log("\n" + "=".repeat(60));
    console.log("SETTING UP RUNTIME CREATION PERFORMANCE TEST ENVIRONMENT");
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
      organizationName: "Runtime Perf Test Org",
      userName: "Runtime Perf Test User",
      userEmail: `runtime-perf-test-${Date.now()}@eliza.test`,
      creditBalance: 1000.0,
    });
    console.log("Test data created");
    console.log("=".repeat(60) + "\n");
  }, 60000);

  afterAll(async () => {
    console.log("\nCleaning up runtime creation performance test...");
    collector.printSummary();
    for (const rt of runtimes) {
      await rt.cleanup();
    }
    if (testData && connectionString) {
      await cleanupTestData(connectionString, testData.organization.id).catch((err) =>
        console.warn(`Data cleanup warning: ${err}`),
      );
    }
  });

  test("should measure CHAT mode runtime creation", async () => {
    const runs = 3;
    const times: number[] = [];

    for (let i = 0; i < runs; i++) {
      const timer = new HRTimer(`chatRuntime-${i}`);
      const runtime = await createTestRuntime({
        testData,
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      });
      const result = timer.stop();
      times.push(result.durationMs);
      runtimes.push(runtime);
      collector.start("chatRuntime");
      collector.stop("chatRuntime", { run: i, durationMs: result.durationMs });
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);

    console.log("\nCHAT Runtime Creation:");
    console.log(`   Runs: ${runs}`);
    console.log(`   Average: ${avg.toFixed(1)}ms`);
    console.log(`   Min: ${min.toFixed(1)}ms`);
    console.log(`   Max: ${max.toFixed(1)}ms`);

    // Target: <3000ms for CHAT runtime
    if (avg > 3000) {
      console.warn(`CHAT runtime avg (${avg.toFixed(0)}ms) exceeds 3s target`);
    }

    expect(avg).toBeGreaterThan(0);
  }, 120000);

  test("should measure CHAT mode runtime creation", async () => {
    const runs = 3;
    const times: number[] = [];

    for (let i = 0; i < runs; i++) {
      const timer = new HRTimer(`assistantRuntime-${i}`);
      const runtime = await createTestRuntime({
        testData,
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      });
      const result = timer.stop();
      times.push(result.durationMs);
      runtimes.push(runtime);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);

    console.log("\nCHAT Runtime Creation:");
    console.log(`   Runs: ${runs}`);
    console.log(`   Average: ${avg.toFixed(1)}ms`);
    console.log(`   Min: ${min.toFixed(1)}ms`);
    console.log(`   Max: ${max.toFixed(1)}ms`);

    // Target: <5000ms for CHAT runtime (includes MCP init)
    if (avg > 5000) {
      console.warn(`CHAT runtime avg (${avg.toFixed(0)}ms) exceeds 5s target`);
    }

    expect(avg).toBeGreaterThan(0);
  }, 180000);
});

// ============================================================================
// Database Query Performance Tests
// ============================================================================

describe.skipIf(!hasDatabaseUrl)("Database Query Performance", () => {
  // Local test state (isolated to this describe block)
  let connectionString: string;
  let testData: TestDataSet;
  let testRuntime: TestRuntimeResult;
  let testUser: TestUserContext;

  beforeAll(async () => {
    console.log("\n" + "=".repeat(60));
    console.log("SETTING UP DATABASE QUERY PERFORMANCE TEST ENVIRONMENT");
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
      organizationName: "DB Query Perf Test Org",
      userName: "DB Query Perf Test User",
      userEmail: `db-query-perf-test-${Date.now()}@eliza.test`,
      creditBalance: 1000.0,
    });
    console.log("Test data created");

    testRuntime = await createTestRuntime({
      testData,
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });
    testUser = await createTestUser(testRuntime.runtime, "DBPerfTestUser");
    console.log("=".repeat(60) + "\n");
  }, 120000);

  afterAll(async () => {
    console.log("\nCleaning up database query performance test...");
    if (testRuntime) {
      await testRuntime.cleanup();
    }
    if (testData && connectionString) {
      await cleanupTestData(connectionString, testData.organization.id).catch((err) =>
        console.warn(`Data cleanup warning: ${err}`),
      );
    }
  });

  test("should measure entity creation time", async () => {
    const runs = 5;
    const times: number[] = [];

    for (let i = 0; i < runs; i++) {
      const timer = new HRTimer(`entityCreate-${i}`);
      try {
        await testRuntime.runtime.createEntity({
          id: uuidv4() as UUID,
          agentId: testRuntime.agentId as UUID,
          names: [`PerfEntity${i}`],
          metadata: { type: "test", index: i },
        });
      } catch (_e) {
        // Ignore duplicate errors
      }
      const result = timer.stop();
      times.push(result.durationMs);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`\nEntity Creation: avg ${avg.toFixed(1)}ms (${runs} runs)`);
    if (avg > LOCAL_DB_QUERY_WARNING_MS) {
      console.warn(`Entity creation avg (${avg.toFixed(0)}ms) exceeds soft 500ms target`);
    }

    expect(avg).toBeGreaterThan(0);
    expect(avg).toBeLessThan(LOCAL_DB_QUERY_TIMEOUT_MS);
  });

  test("should measure memory creation time", async () => {
    const runs = 5;
    const times: number[] = [];

    for (let i = 0; i < runs; i++) {
      const timer = new HRTimer(`memoryCreate-${i}`);
      await testRuntime.runtime.createMemory(
        {
          id: uuidv4() as UUID,
          entityId: testUser.entityId,
          agentId: testRuntime.agentId as UUID,
          roomId: testUser.roomId,
          content: { text: `Performance test message ${i}` },
          createdAt: Date.now(),
        },
        "messages",
      );
      const result = timer.stop();
      times.push(result.durationMs);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`\nMemory Creation: avg ${avg.toFixed(1)}ms (${runs} runs)`);
    if (avg > LOCAL_DB_QUERY_WARNING_MS) {
      console.warn(`Memory creation avg (${avg.toFixed(0)}ms) exceeds soft 500ms target`);
    }

    expect(avg).toBeGreaterThan(0);
    expect(avg).toBeLessThan(LOCAL_DB_QUERY_TIMEOUT_MS);
  });

  test("should measure memory retrieval time", async () => {
    // Create some memories first
    for (let i = 0; i < 10; i++) {
      await testRuntime.runtime.createMemory(
        {
          id: uuidv4() as UUID,
          entityId: testUser.entityId,
          agentId: testRuntime.agentId as UUID,
          roomId: testUser.roomId,
          content: { text: `Retrieval test message ${i}` },
          createdAt: Date.now(),
        },
        "messages",
      );
    }

    const runs = 5;
    const times: number[] = [];

    for (let i = 0; i < runs; i++) {
      const timer = new HRTimer(`memoryRetrieve-${i}`);
      await testRuntime.runtime.getMemories({
        roomId: testUser.roomId,
        tableName: "messages",
        count: 10,
      });
      const result = timer.stop();
      times.push(result.durationMs);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`\nMemory Retrieval (10 items): avg ${avg.toFixed(1)}ms (${runs} runs)`);

    expect(avg).toBeGreaterThan(0);
    expect(avg).toBeLessThan(5000); // Retrieval should complete within 5s (Neon remote DB has higher latency)
  });
});

// ============================================================================
// Runtime Caching Performance Tests
// ============================================================================

describe.skipIf(!hasDatabaseUrl)("Runtime Caching Performance", () => {
  // Local test state (isolated to this describe block)
  let connectionString: string;
  let testData: TestDataSet;
  const runtimes: TestRuntimeResult[] = [];

  beforeAll(async () => {
    console.log("\n" + "=".repeat(60));
    console.log("SETTING UP RUNTIME CACHING PERFORMANCE TEST ENVIRONMENT");
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
      organizationName: "Caching Perf Test Org",
      userName: "Caching Perf Test User",
      userEmail: `caching-perf-test-${Date.now()}@eliza.test`,
      creditBalance: 1000.0,
    });
    console.log("Test data created");
    console.log("=".repeat(60) + "\n");
  }, 60000);

  afterAll(async () => {
    console.log("\nCleaning up runtime caching performance test...");
    for (const rt of runtimes) {
      await rt.cleanup();
    }
    if (testData && connectionString) {
      await cleanupTestData(connectionString, testData.organization.id).catch((err) =>
        console.warn(`Data cleanup warning: ${err}`),
      );
    }
  });

  test("should measure cache hit vs cache miss performance", async () => {
    // First call - cache miss
    const coldTimer = new HRTimer("coldStart");
    const runtime1 = await createTestRuntime({
      testData,
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });
    const coldResult = coldTimer.stop();
    runtimes.push(runtime1);

    // Second call - should be cache hit (same context)
    const warmTimer = new HRTimer("warmStart");
    const runtime2 = await createTestRuntime({
      testData,
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });
    const warmResult = warmTimer.stop();
    runtimes.push(runtime2);

    console.log("\nCache Performance:");
    console.log(`   Cold start (cache miss): ${coldResult.durationMs.toFixed(1)}ms`);
    console.log(`   Warm start (cache hit): ${warmResult.durationMs.toFixed(1)}ms`);

    if (warmResult.durationMs < coldResult.durationMs) {
      const speedup =
        ((coldResult.durationMs - warmResult.durationMs) / coldResult.durationMs) * 100;
      console.log(`   Speedup: ${speedup.toFixed(1)}%`);
    }

    expect(coldResult.durationMs).toBeGreaterThan(0);
    expect(warmResult.durationMs).toBeGreaterThan(0);
  }, 120000);
});
