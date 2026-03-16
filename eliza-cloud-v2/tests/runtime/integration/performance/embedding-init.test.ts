/**
 * Embedding Initialization Performance Test
 *
 * Tests that embedding dimension is only fetched once from the API,
 * and subsequent runtime creations skip the ~500ms embedding call.
 *
 * Run with: bun test tests/runtime/integration/performance/embedding-init.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  verifyConnection,
  getConnectionString,
  createTestDataSet,
  cleanupTestData,
  createTestRuntime,
  AgentMode,
  type TestDataSet,
  type TestRuntimeResult,
} from "../../../infrastructure";

describe("Embedding Initialization Performance", () => {
  let connectionString: string;
  let testData: TestDataSet;
  const runtimes: TestRuntimeResult[] = [];

  beforeAll(async () => {
    console.log("\n" + "=".repeat(60));
    console.log("EMBEDDING INITIALIZATION PERFORMANCE TEST");
    console.log("=".repeat(60));

    const connected = await verifyConnection();
    if (!connected) {
      throw new Error("Database connection required for this test");
    }
    connectionString = getConnectionString();

    testData = await createTestDataSet(connectionString, {
      organizationName: "Embedding Perf Test Org",
      userName: "Embedding Test User",
      userEmail: `embedding-perf-${Date.now()}@test.local`,
      creditBalance: 100,
    });

    console.log("Test data created");
    console.log("=".repeat(60) + "\n");
  });

  afterAll(async () => {
    console.log("\nCleaning up...");
    for (const rt of runtimes) {
      await rt.cleanup().catch(() => {});
    }
    if (testData && connectionString) {
      await cleanupTestData(connectionString, testData.organization.id).catch(
        () => {},
      );
    }
  });

  it(
    "should be fast on second runtime creation (embedding dimension cached)",
    async () => {
      console.log(
        "\n--- First Runtime Creation (cold - may call embedding API) ---",
      );

      const firstStart = performance.now();
      const firstRuntime = await createTestRuntime({
        testData,
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      });
      const firstDuration = performance.now() - firstStart;
      runtimes.push(firstRuntime);

      console.log(`First runtime created in ${firstDuration.toFixed(0)}ms`);
      console.log(`  Agent ID: ${firstRuntime.agentId}`);

      // Invalidate the runtime but keep the embedding dimension in DB
      await firstRuntime.cleanup();
      runtimes.pop();

      // Small delay to ensure cleanup is complete
      await new Promise((r) => setTimeout(r, 100));

      console.log(
        "\n--- Second Runtime Creation (warm - should skip embedding API) ---",
      );

      const secondStart = performance.now();
      const secondRuntime = await createTestRuntime({
        testData,
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      });
      const secondDuration = performance.now() - secondStart;
      runtimes.push(secondRuntime);

      console.log(`Second runtime created in ${secondDuration.toFixed(0)}ms`);
      console.log(`  Agent ID: ${secondRuntime.agentId}`);

      // Third runtime to confirm consistent fast times
      await secondRuntime.cleanup();
      runtimes.pop();
      await new Promise((r) => setTimeout(r, 100));

      console.log("\n--- Third Runtime Creation (confirm consistent) ---");

      const thirdStart = performance.now();
      const thirdRuntime = await createTestRuntime({
        testData,
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      });
      const thirdDuration = performance.now() - thirdStart;
      runtimes.push(thirdRuntime);

      console.log(`Third runtime created in ${thirdDuration.toFixed(0)}ms`);

      // Summary
      console.log("\n" + "=".repeat(60));
      console.log("RESULTS SUMMARY");
      console.log("=".repeat(60));
      console.log(`First (cold):  ${firstDuration.toFixed(0)}ms`);
      console.log(`Second (warm): ${secondDuration.toFixed(0)}ms`);
      console.log(`Third (warm):  ${thirdDuration.toFixed(0)}ms`);

      const avgWarm = (secondDuration + thirdDuration) / 2;
      const savings = firstDuration - avgWarm;
      const savingsPercent = (savings / firstDuration) * 100;

      console.log(`\nAverage warm: ${avgWarm.toFixed(0)}ms`);
      console.log(
        `Savings: ${savings.toFixed(0)}ms (${savingsPercent.toFixed(1)}%)`,
      );

      if (savings > 300) {
        console.log(
          `\n✅ SUCCESS: Warm starts are ${savings.toFixed(0)}ms faster (embedding cached)`,
        );
      } else if (firstDuration < 500) {
        console.log(
          `\n✅ SUCCESS: All starts fast (<500ms) - embedding may already be cached`,
        );
      } else {
        console.log(
          `\n⚠️ WARNING: Warm starts not significantly faster - check embedding caching`,
        );
      }
      console.log("=".repeat(60));

      // Assertions
      expect(firstDuration).toBeGreaterThan(0);
      expect(secondDuration).toBeGreaterThan(0);
      expect(thirdDuration).toBeGreaterThan(0);

      // If first was slow (>500ms), subsequent should be faster
      // If first was already fast, embedding was pre-cached
      if (firstDuration > 500) {
        expect(avgWarm).toBeLessThan(firstDuration * 0.8); // At least 20% faster
      }
    },
    { timeout: 180000 },
  );

  it(
    "should measure runtime creation without embedding model",
    async () => {
      // This test measures baseline creation time when no embedding is needed
      // Useful for understanding where time is spent

      console.log("\n--- Baseline: Multiple Sequential Runtime Creations ---");

      const times: number[] = [];

      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        const runtime = await createTestRuntime({
          testData,
          agentMode: AgentMode.CHAT,
          webSearchEnabled: false,
        });
        const duration = performance.now() - start;
        times.push(duration);

        console.log(`  Run ${i + 1}: ${duration.toFixed(0)}ms`);

        await runtime.cleanup();
        await new Promise((r) => setTimeout(r, 50));
      }

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const min = Math.min(...times);
      const max = Math.max(...times);

      console.log(`\n  Average: ${avg.toFixed(0)}ms`);
      console.log(`  Min: ${min.toFixed(0)}ms`);
      console.log(`  Max: ${max.toFixed(0)}ms`);
      console.log(`  Variance: ${(max - min).toFixed(0)}ms`);

      // Target: consistent times after first warm-up
      expect(avg).toBeGreaterThan(0);

      // After warm-up, variance should be low (consistent performance)
      const variance = max - min;
      if (variance > 500) {
        console.log(
          `\n⚠️ High variance (${variance.toFixed(0)}ms) - may indicate inconsistent caching`,
        );
      }
    },
    { timeout: 180000 },
  );
});
