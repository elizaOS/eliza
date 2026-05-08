/**
 * RuntimeFactory - Caching Behavior Integration Tests
 *
 * Tests the production RuntimeFactory caching behavior and performance benchmarks.
 * This is a self-contained test file with its own setup/teardown.
 *
 * Run with: bun test tests/runtime/integration/runtime-factory/caching.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mcpTestCharacter } from "../../../fixtures/mcp-test-character";
import {
  AgentMode,
  // Test helpers
  buildUserContext,
  cleanupTestData,
  // Test data
  createTestDataSet,
  endTimer,
  getConnectionString,
  getRuntimeCacheStats,
  // Local database
  hasDatabaseUrl,
  invalidateRuntime,
  isRuntimeCached,
  logTimings,
  // Production RuntimeFactory
  runtimeFactory,
  // Timing
  startTimer,
  type TestDataSet,
  verifyConnection,
} from "../../../infrastructure";

// ============================================================================
// Local Test State (isolated to this file)
// ============================================================================

let connectionString: string;
let testData: TestDataSet;
const timings: Record<string, number> = {};

describe.skipIf(!hasDatabaseUrl)("RuntimeFactory - Caching Behavior", () => {
  beforeAll(async () => {
    console.log("\n" + "=".repeat(60));
    console.log("SETTING UP CACHING TEST ENVIRONMENT");
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
      organizationName: "Caching Test Org",
      userName: "Caching Test User",
      userEmail: `caching-test-${Date.now()}@eliza.test`,
      creditBalance: 1000.0,
      includeCharacter: true,
      characterName: "Mira",
      characterData: mcpTestCharacter as unknown as Record<string, unknown>,
      characterSettings: mcpTestCharacter.settings as Record<string, unknown>,
    });
    console.log("Test data created");
    console.log(`   API Key: ${testData.apiKey.keyPrefix}...`);
    console.log(`   Credits: $${testData.organization.creditBalance}`);
    console.log("=".repeat(60) + "\n");
  }, 60000);

  afterAll(async () => {
    console.log("\nCleaning up caching test...");
    if (testData && connectionString) {
      await cleanupTestData(connectionString, testData.organization.id).catch((err) =>
        console.warn(`Data cleanup warning: ${err}`),
      );
    }
    logTimings("Caching Tests", timings);
  });

  it("should cache runtime on first creation", async () => {
    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });

    startTimer("cache_cold");
    const runtime1 = await runtimeFactory.createRuntimeForUser(userContext);
    timings.cacheCold = endTimer("cache_cold");

    expect(isRuntimeCached(runtime1.agentId as string)).toBe(true);
    console.log(`\nCold start: ${timings.cacheCold}ms`);

    // Don't cleanup - leave cached for next test
  }, 60000);

  it("should return cached runtime on second call", async () => {
    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });

    startTimer("cache_warm");
    const runtime2 = await runtimeFactory.createRuntimeForUser(userContext);
    timings.cacheWarm = endTimer("cache_warm");

    expect(runtime2).toBeDefined();
    console.log(`\nWarm start: ${timings.cacheWarm}ms`);
    console.log(
      `   Speedup: ${(((timings.cacheCold - timings.cacheWarm) / timings.cacheCold) * 100).toFixed(1)}%`,
    );

    // Cleanup
    await invalidateRuntime(runtime2.agentId as string);
  }, 60000);

  it("should report cache stats", () => {
    const stats = getRuntimeCacheStats();
    expect(stats).toBeDefined();
    expect(stats.runtime).toBeDefined();
    console.log(`\nCache stats: size=${stats.runtime.size}/${stats.runtime.maxSize}`);
  });
});

// ============================================================================
// Performance Benchmarks
// ============================================================================

describe.skipIf(!hasDatabaseUrl)("RuntimeFactory - Performance Benchmarks", () => {
  let localConnectionString: string;
  let localTestData: TestDataSet;
  const localTimings: Record<string, number> = {};

  beforeAll(async () => {
    console.log("\n" + "=".repeat(60));
    console.log("SETTING UP PERFORMANCE BENCHMARK ENVIRONMENT");
    console.log("=".repeat(60));

    // Verify database connection
    const connected = await verifyConnection();
    if (!connected) {
      throw new Error(
        "Cannot connect to database. Make sure DATABASE_URL is set and server is running.",
      );
    }
    localConnectionString = getConnectionString();
    console.log("Database connected");

    // Create test data with unique identifiers
    localTestData = await createTestDataSet(localConnectionString, {
      organizationName: "Performance Benchmark Test Org",
      userName: "Performance Benchmark Test User",
      userEmail: `perf-benchmark-test-${Date.now()}@eliza.test`,
      creditBalance: 1000.0,
      includeCharacter: true,
      characterName: "Mira",
      characterData: mcpTestCharacter as unknown as Record<string, unknown>,
      characterSettings: mcpTestCharacter.settings as Record<string, unknown>,
    });
    console.log("Test data created");
    console.log(`   API Key: ${localTestData.apiKey.keyPrefix}...`);
    console.log(`   Credits: $${localTestData.organization.creditBalance}`);
    console.log("=".repeat(60) + "\n");
  }, 60000);

  afterAll(async () => {
    console.log("\nCleaning up performance benchmark test...");
    if (localTestData && localConnectionString) {
      await cleanupTestData(localConnectionString, localTestData.organization.id).catch((err) =>
        console.warn(`Data cleanup warning: ${err}`),
      );
    }
    logTimings("Performance Benchmark Tests", localTimings);
  });

  it("should benchmark runtime creation times", async () => {
    const modes = [AgentMode.CHAT];
    const benchmarks: Record<string, number> = {};

    for (const mode of modes) {
      // Ensure clean state
      const userContext = buildUserContext(localTestData, {
        agentMode: mode,
        webSearchEnabled: false,
      });

      startTimer(`bench_${mode}`);
      const runtime = await runtimeFactory.createRuntimeForUser(userContext);
      benchmarks[mode] = endTimer(`bench_${mode}`);

      await invalidateRuntime(runtime.agentId as string);
    }

    console.log("\nRuntime Creation Benchmarks:");
    for (const [mode, time] of Object.entries(benchmarks)) {
      console.log(`   ${mode}: ${time}ms`);
      localTimings[`benchmark_${mode}`] = time;
    }

    // Chat runtime should create in under 10 seconds
    expect(benchmarks[AgentMode.CHAT]).toBeLessThan(10000);
  }, 180000);
});
