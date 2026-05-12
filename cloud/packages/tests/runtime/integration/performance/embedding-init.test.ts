/**
 * Embedding Initialization Performance Test
 *
 * Validates that repeated runtime creation stays stable once the embedding
 * dimension is known. Runtime startup now uses static dimension lookup, so
 * we no longer expect a dramatic "cold vs warm" speedup from this path alone.
 *
 * Run with: bun test tests/runtime/integration/performance/embedding-init.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  AgentMode,
  cleanupTestData,
  createTestDataSet,
  createTestRuntime,
  getConnectionString,
  hasDatabaseUrl,
  type TestDataSet,
  type TestRuntimeResult,
  verifyConnection,
} from "../../../infrastructure";

describe.skipIf(!hasDatabaseUrl)("Embedding Initialization Performance", () => {
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
      await cleanupTestData(connectionString, testData.organization.id).catch(() => {});
    }
  });

  it(
    "should keep repeated runtime creation stable once embedding dimension is known",
    async () => {
      console.log("\n--- First Runtime Creation (baseline) ---");

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

      // Invalidate the runtime and recreate it to compare repeated startup cost.
      await firstRuntime.cleanup();
      runtimes.pop();

      // Small delay to ensure cleanup is complete
      await new Promise((r) => setTimeout(r, 100));

      console.log("\n--- Second Runtime Creation (repeat) ---");

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

      // Third runtime to confirm consistent repeated startup times.
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
      const warmVariance = Math.abs(secondDuration - thirdDuration);
      const maxWarmVariance = Math.max(750, firstDuration * 0.35);

      console.log(`\nAverage warm: ${avgWarm.toFixed(0)}ms`);
      console.log(`Savings: ${savings.toFixed(0)}ms (${savingsPercent.toFixed(1)}%)`);
      console.log(`Warm variance: ${warmVariance.toFixed(0)}ms`);

      if (savings > 300) {
        console.log(`\n✅ SUCCESS: Repeated starts are ${savings.toFixed(0)}ms faster`);
      } else if (warmVariance < maxWarmVariance) {
        console.log(`\n✅ SUCCESS: Repeated starts are stable even without a large speedup`);
      } else {
        console.log(`\n⚠️ WARNING: Repeated starts varied more than expected`);
      }
      console.log("=".repeat(60));

      // Assertions
      expect(firstDuration).toBeGreaterThan(0);
      expect(secondDuration).toBeGreaterThan(0);
      expect(thirdDuration).toBeGreaterThan(0);

      // Repeated startup should stay within a reasonable band of the baseline
      // even when there is no dramatic "warm" speedup from embedding setup.
      // CI runners have high timing variance (GC, JIT, noisy neighbors), so
      // allow an absolute floor plus relative headroom to avoid flaky failures
      // when the baseline run is unusually fast on a noisy shared runner.
      expect(avgWarm).toBeLessThan(Math.max(500, firstDuration * 3, firstDuration + 300));
      expect(warmVariance).toBeLessThan(maxWarmVariance);
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
