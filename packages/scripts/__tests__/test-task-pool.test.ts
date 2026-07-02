import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  isParallelSafeTask,
  normalizeConcurrency,
  parseShardSpec,
  partitionTasks,
  runPool,
  SERIALIZE_PACKAGES,
  taskBelongsToShard,
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

describe("process supervision boundary", () => {
  test("documents why dev supervisors and the test pool stay split", () => {
    const doc = readFileSync(
      new URL("../process-supervision.md", import.meta.url),
      "utf8",
    );

    expect(doc).toContain("keep the seams separate");
    expect(doc).toContain("api-supervisor.mjs");
    expect(doc).toContain("dev-all.mjs");
    expect(doc).toContain("run-all-tests.mjs");
    expect(doc).toContain("long-lived single-child supervisor");
    expect(doc).toContain("bounded batch runner");
    expect(doc).toContain("digest.readUInt32BE(0)");
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

describe("parseShardSpec", () => {
  test("parses a valid N/M spec", () => {
    expect(parseShardSpec("2/4")).toEqual({ index: 2, total: 4 });
    expect(parseShardSpec("1/1")).toEqual({ index: 1, total: 1 });
    expect(parseShardSpec("4/4")).toEqual({ index: 4, total: 4 });
  });

  test("returns null for absent specs", () => {
    expect(parseShardSpec("")).toBeNull();
    expect(parseShardSpec(undefined)).toBeNull();
    expect(parseShardSpec(null)).toBeNull();
  });

  test("returns null for malformed or out-of-range specs", () => {
    for (const bad of [
      "3", // missing /M
      "a/b", // non-numeric
      "0/4", // index < 1
      "5/4", // index > total
      "2/0", // total <= 0
      "-1/4", // negative index
      "1/2/3", // too many parts
      "/4", // empty index
      "2/", // empty total
    ]) {
      expect(parseShardSpec(bad)).toBeNull();
    }
  });
});

describe("taskBelongsToShard", () => {
  test("everything belongs when there is no shard config", () => {
    expect(taskBelongsToShard("packages/core", null)).toBe(true);
  });

  test("membership is deterministic for the same key + config", () => {
    const cfg = { index: 2, total: 5 };
    const a = taskBelongsToShard("packages/app-core", cfg);
    const b = taskBelongsToShard("packages/app-core", cfg);
    expect(a).toBe(b);
  });

  test("a single shard (M=1) owns every task", () => {
    const cfg = { index: 1, total: 1 };
    for (const key of [
      "packages/core",
      "plugins/plugin-openai",
      "packages/ui",
    ]) {
      expect(taskBelongsToShard(key, cfg)).toBe(true);
    }
  });

  test("every task lands in exactly one shard, across many M (partition invariant)", () => {
    const keys = Array.from({ length: 300 }, (_, i) => `packages/pkg-${i}`);
    for (const total of [2, 3, 4, 5, 8, 13]) {
      for (const key of keys) {
        const owners = [];
        for (let index = 1; index <= total; index++) {
          if (taskBelongsToShard(key, { index, total })) {
            owners.push(index);
          }
        }
        // Each key is claimed by precisely one shard — no gaps, no overlaps.
        expect(owners).toHaveLength(1);
      }
    }
  });

  test("shards are reasonably balanced (no shard is wildly over/under-loaded)", () => {
    const total = 4;
    const keys = Array.from({ length: 800 }, (_, i) => `plugins/plugin-${i}`);
    const counts = new Array(total).fill(0);
    for (const key of keys) {
      for (let index = 1; index <= total; index++) {
        if (taskBelongsToShard(key, { index, total })) {
          counts[index - 1]++;
        }
      }
    }
    expect(counts.reduce((a, b) => a + b, 0)).toBe(keys.length);
    // Even split would be 200/shard; allow generous slack for hash variance.
    for (const count of counts) {
      expect(count).toBeGreaterThan(120);
      expect(count).toBeLessThan(280);
    }
  });
});

describe("CI plugin sharding contract", () => {
  const rootPackageJson = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const testWorkflow = readFileSync(
    new URL("../../../.github/workflows/test.yml", import.meta.url),
    "utf8",
  );
  const qualityWorkflow = readFileSync(
    new URL("../../../.github/workflows/quality.yml", import.meta.url),
    "utf8",
  );

  test("root test:plugins uses the shard-aware cross-package runner", () => {
    const script = rootPackageJson.scripts["test:plugins"];
    expect(script).toContain("run-all-tests.mjs");
    expect(script).toContain("TEST_PACKAGE_FILTER='\\(plugins/'");
    expect(script).toContain("TEST_SCRIPT_FILTER='^test$'");
    expect(script).toContain("--only=test");
    expect(script).toContain("--no-cloud");
    expect(script).toContain("--concurrency=3");
  });

  test("Tests workflow shards plugin tests and keeps a stable aggregate check", () => {
    expect(testWorkflow).toMatch(
      /plugin-tests:\s+name:\s+Plugin Tests \(\$\{\{ matrix\.shard \}\}\/4\)[\s\S]*?strategy:[\s\S]*?fail-fast:\s+false[\s\S]*?matrix:[\s\S]*?shard:\s+\[1,\s*2,\s*3,\s*4\]/,
    );
    expect(testWorkflow).toMatch(/TEST_SHARD:\s+\$\{\{ matrix\.shard \}\}\/4/);
    expect(testWorkflow).toMatch(
      /plugin-tests-status:\s+name:\s+Plugin Tests[\s\S]*?needs:[\s\S]*?-\s+plugin-tests/,
    );
    expect(testWorkflow).toMatch(
      /test-status:[\s\S]*?needs:[\s\S]*?-\s+plugin-tests-status/,
    );
  });

  test("Quality workflow gates develop PRs with static scans and lint", () => {
    expect(qualityWorkflow).toMatch(
      /develop-static-gate:[\s\S]*?Prompt secret scan[\s\S]*?check:secrets[\s\S]*?UI determinism self-test[\s\S]*?audit:ui-determinism:self-test[\s\S]*?UI determinism gate[\s\S]*?audit:ui-determinism/,
    );
    expect(qualityWorkflow).toMatch(
      /develop-lint-gate:[\s\S]*?install-command: bun install[\s\S]*?Run lint[\s\S]*?bun run lint/,
    );
    expect(qualityWorkflow).not.toMatch(
      /develop-static-gate:[\s\S]*?Run lint[\s\S]*?bun run lint[\s\S]*?develop-lint-gate:/,
    );
  });
});

describe("run-all-tests plan mode", () => {
  const runnerPath = new URL("../run-all-tests.mjs", import.meta.url);

  function runPlan(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [runnerPath.pathname, ...args], {
      cwd: new URL("../../..", import.meta.url).pathname,
      encoding: "utf8",
      env: {
        ...process.env,
        TEST_LANE: "pr",
        TEST_PACKAGE_FILTER: "",
        TEST_SCRIPT_FILTER: "",
        TEST_SHARD: "",
        TEST_START_AT: "",
        ...env,
      },
    });
  }

  test("prints a JSON inventory without preparing services or starting package tests", () => {
    const result = runPlan(
      [
        "--plan=json",
        "--only=test",
        "--no-cloud",
        "--filter=^@elizaos/core \\(packages/core\\)#test$",
      ],
      // If plan mode regresses and prepares PostgreSQL or spawns package
      // scripts, this stripped PATH makes the side effect visible.
      { PATH: "" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("[eliza-test] START");
    expect(result.stdout).not.toContain("PostgreSQL");
    const plan = JSON.parse(result.stdout);
    expect(plan.summary).toMatchObject({
      lane: "pr",
      only: "test",
      noCloud: true,
      taskCount: 1,
      cloudStep: false,
    });
    expect(plan.tasks).toEqual([
      {
        packageName: "@elizaos/core",
        relativeDir: "packages/core",
        scriptName: "test",
        label: "@elizaos/core (packages/core)#test",
        parallelSafe: true,
      },
    ]);
    expect(plan.cloudStep).toBeNull();
  });

  test("bare --plan prints text and keeps the cloud step visible", () => {
    const result = runPlan([
      "--plan",
      "--only=test",
      "--filter=^@elizaos/core \\(packages/core\\)#test$",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[eliza-test] PLAN lane=pr only=test");
    expect(result.stdout).toContain("[eliza-test] PLAN cloud-step=yes");
    expect(result.stdout).toContain(
      "[eliza-test] PLAN parallel @elizaos/core (packages/core)#test",
    );
    expect(result.stdout).not.toContain("[eliza-test] START");
  });
});
