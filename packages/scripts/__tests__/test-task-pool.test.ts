import { describe, expect, test } from "bun:test";

import {
  isParallelSafeTask,
  normalizeConcurrency,
  partitionTasks,
  runPool,
  SERIALIZE_PACKAGES,
} from "../lib/test-task-pool.mjs";

describe("isParallelSafeTask", () => {
  test("plain `test` script in the pr lane is parallel-safe", () => {
    expect(
      isParallelSafeTask({
        scriptName: "test",
        lane: "pr",
        packageName: "@elizaos/core",
      }),
    ).toBe(true);
  });

  test("extra-script lanes (e2e/integration/...) are never parallel-safe", () => {
    for (const scriptName of [
      "test:e2e",
      "test:integration",
      "test:playwright",
      "test:ui",
      "test:live",
    ]) {
      expect(
        isParallelSafeTask({
          scriptName,
          lane: "pr",
          packageName: "@elizaos/core",
        }),
      ).toBe(false);
    }
  });

  test("any lane other than pr forces serial (real-API / shared DB)", () => {
    expect(
      isParallelSafeTask({
        scriptName: "test",
        lane: "post-merge",
        packageName: "@elizaos/core",
      }),
    ).toBe(false);
  });

  test("denylisted packages stay serial even for their `test` script", () => {
    for (const packageName of SERIALIZE_PACKAGES) {
      expect(
        isParallelSafeTask({ scriptName: "test", lane: "pr", packageName }),
      ).toBe(false);
    }
  });

  test("denylist matches the packages the root test:plugins sweep pulls out", () => {
    expect(SERIALIZE_PACKAGES.has("@elizaos/plugin-personal-assistant")).toBe(
      true,
    );
    expect(SERIALIZE_PACKAGES.has("@elizaos/plugin-agent-orchestrator")).toBe(
      true,
    );
    expect(SERIALIZE_PACKAGES.has("@elizaos/plugin-sql")).toBe(true);
  });
});

describe("partitionTasks", () => {
  test("splits into parallel/serial buckets preserving order", () => {
    const tasks = [
      { packageName: "@elizaos/core", scriptName: "test" },
      { packageName: "@elizaos/core", scriptName: "test:e2e" },
      { packageName: "@elizaos/plugin-sql", scriptName: "test" },
      { packageName: "@elizaos/agent", scriptName: "test" },
    ];
    const { parallel, serial } = partitionTasks(tasks, "pr");
    expect(parallel.map((t) => t.packageName)).toEqual([
      "@elizaos/core",
      "@elizaos/agent",
    ]);
    expect(serial.map((t) => `${t.packageName}#${t.scriptName}`)).toEqual([
      "@elizaos/core#test:e2e",
      "@elizaos/plugin-sql#test",
    ]);
  });

  test("post-merge lane puts everything in the serial bucket", () => {
    const tasks = [
      { packageName: "@elizaos/core", scriptName: "test" },
      { packageName: "@elizaos/agent", scriptName: "test" },
    ];
    const { parallel, serial } = partitionTasks(tasks, "post-merge");
    expect(parallel).toHaveLength(0);
    expect(serial).toHaveLength(2);
  });
});

describe("runPool", () => {
  test("preserves result order regardless of completion order", async () => {
    const results = await runPool(
      [30, 10, 20, 0, 5],
      async (ms, i) => {
        await new Promise((r) => setTimeout(r, ms));
        return i;
      },
      3,
    );
    expect(results.map((r) => (r.ok ? r.value : null))).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  test("never runs more than `concurrency` workers at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runPool(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
      4,
    );
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test("captures thrown errors as { ok: false } without aborting siblings", async () => {
    const results = await runPool(
      [1, 2, 3, 4],
      async (n) => {
        if (n % 2 === 0) {
          throw new Error(`boom ${n}`);
        }
        return n;
      },
      2,
    );
    expect(results[0]).toEqual({ ok: true, value: 1 });
    expect(results[1].ok).toBe(false);
    expect(results[2]).toEqual({ ok: true, value: 3 });
    expect(results[3].ok).toBe(false);
    // All four ran — a thrown worker does not cancel the rest of the pool.
    expect(results.every((r) => r !== undefined)).toBe(true);
  });

  test("empty input resolves to an empty array", async () => {
    expect(await runPool([], async () => 1, 4)).toEqual([]);
  });

  test("concurrency is clamped to at least 1 and at most item count", async () => {
    const results = await runPool([1, 2], async (n) => n, 99);
    expect(results.map((r) => r.value)).toEqual([1, 2]);
  });
});

describe("normalizeConcurrency", () => {
  test("defaults to 1 (fully serial) for empty/invalid input", () => {
    for (const value of [undefined, null, "", "abc", "0", "-3", 0, -1]) {
      expect(normalizeConcurrency(value)).toBe(1);
    }
  });

  test("parses positive integers from string or number", () => {
    expect(normalizeConcurrency("4")).toBe(4);
    expect(normalizeConcurrency(8)).toBe(8);
    expect(normalizeConcurrency("3.9")).toBe(3);
  });
});
