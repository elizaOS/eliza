/**
 * Performance Tests
 *
 * Measures runtime performance for serverless optimization.
 * Uses local database (same as running server).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import {
  AgentMode,
  cleanupTestData,
  createTestDataSet,
  createTestRuntime,
  createTestUser,
  getConnectionString,
  hasDatabaseUrl,
  type TestDataSet,
  type TestRuntimeResult,
  type TestUserContext,
  verifyConnection,
} from "../infrastructure";
import { HRTimer, TimingCollector } from "../infrastructure/timing";

const LOCAL_DB_QUERY_WARNING_MS = 500;
const LOCAL_DB_QUERY_TIMEOUT_MS = 5000;

// Test state
let connectionString: string;
let testData: TestDataSet;

// Setup function - uses local database
async function setupEnvironment(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 SETTING UP PERFORMANCE TEST ENVIRONMENT (Local DB)");
  console.log("=".repeat(60));

  const connected = await verifyConnection();
  if (!connected) {
    throw new Error(
      "Cannot connect to database. Make sure DATABASE_URL is set and server is running.",
    );
  }
  connectionString = getConnectionString();
  console.log(`✅ Database connected`);

  testData = await createTestDataSet(connectionString, {
    organizationName: "Performance Test Org",
    userName: "Performance Test User",
    userEmail: `perf-test-${Date.now()}@eliza.test`,
    creditBalance: 1000.0,
  });
  console.log("✅ Test data created");
  console.log("=".repeat(60) + "\n");
}

// Cleanup function
async function cleanupEnvironment(): Promise<void> {
  console.log("\n🧹 Cleaning up...");
  if (testData && connectionString) {
    await cleanupTestData(connectionString, testData.organization.id).catch(() => {});
  }
}

describe.skipIf(!hasDatabaseUrl)("Runtime Creation Performance", () => {
  const runtimes: TestRuntimeResult[] = [];
  const collector = new TimingCollector();

  beforeAll(setupEnvironment, 60000);

  afterAll(async () => {
    collector.printSummary();
    for (const rt of runtimes) {
      await rt.cleanup();
    }
    await cleanupEnvironment();
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

    console.log("\n📊 CHAT Runtime Creation:");
    console.log(`   Runs: ${runs}`);
    console.log(`   Average: ${avg.toFixed(1)}ms`);
    console.log(`   Min: ${min.toFixed(1)}ms`);
    console.log(`   Max: ${max.toFixed(1)}ms`);

    // Target: <3000ms for CHAT runtime
    if (avg > 3000) {
      console.warn(`⚠️ CHAT runtime avg (${avg.toFixed(0)}ms) exceeds 3s target`);
    }

    expect(avg).toBeGreaterThan(0);
  }, 120000);

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
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);

    console.log("\n📊 CHAT Runtime Creation:");
    console.log(`   Runs: ${runs}`);
    console.log(`   Average: ${avg.toFixed(1)}ms`);
    console.log(`   Min: ${min.toFixed(1)}ms`);
    console.log(`   Max: ${max.toFixed(1)}ms`);

    // Target: <5000ms for CHAT runtime (includes MCP init)
    if (avg > 5000) {
      console.warn(`⚠️ CHAT runtime avg (${avg.toFixed(0)}ms) exceeds 5s target`);
    }

    expect(avg).toBeGreaterThan(0);
  }, 180000);
});

describe.skipIf(!hasDatabaseUrl)("Database Query Performance", () => {
  let testRuntime: TestRuntimeResult;
  let testUser: TestUserContext;

  beforeAll(async () => {
    await setupEnvironment();
    testRuntime = await createTestRuntime({
      testData,
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });
    testUser = await createTestUser(testRuntime.runtime, "PerfTestUser");
  }, 120000);

  afterAll(async () => {
    if (testRuntime) {
      await testRuntime.cleanup();
    }
    await cleanupEnvironment();
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
    console.log(`\n📊 Entity Creation: avg ${avg.toFixed(1)}ms (${runs} runs)`);
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
    console.log(`\n📊 Memory Creation: avg ${avg.toFixed(1)}ms (${runs} runs)`);
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
    console.log(`\n📊 Memory Retrieval (10 items): avg ${avg.toFixed(1)}ms (${runs} runs)`);

    expect(avg).toBeGreaterThan(0);
    expect(avg).toBeLessThan(5000); // Retrieval should complete within 5s (Neon remote DB has higher latency)
  });
});

describe.skipIf(!hasDatabaseUrl)("Runtime Caching Performance", () => {
  const runtimes: TestRuntimeResult[] = [];

  beforeAll(setupEnvironment, 60000);

  afterAll(async () => {
    for (const rt of runtimes) {
      await rt.cleanup();
    }
    await cleanupEnvironment();
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

    console.log("\n📊 Cache Performance:");
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
