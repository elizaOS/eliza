// Exercises tests test task pool.test automation behavior with deterministic script fixtures.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

import {
  createSerialPackageResolver,
  isParallelSafeTask,
  MAX_TASK_CONCURRENCY,
  normalizeConcurrency,
  parseShardSpec,
  partitionTasks,
  resolveConcurrency,
  runPool,
  serialPackages,
  taskBelongsToShard,
} from "../lib/test-task-pool.mjs";

test("serial package discovery is lazy and memoized", () => {
  let calls = 0;
  const expected = new Set(["@elizaos/example"]);
  const resolve = createSerialPackageResolver(() => {
    calls += 1;
    return expected;
  });

  expect(calls).toBe(0);
  expect(resolve()).toBe(expected);
  expect(resolve()).toBe(expected);
  expect(calls).toBe(1);
});

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
    for (const packageName of serialPackages()) {
      expect(
        isParallelSafeTask({ scriptName: "test", lane: "pr", packageName }),
      ).toBe(false);
    }
  });

  test("denylist matches the packages the root test:plugins sweep pulls out", () => {
    expect(serialPackages().has("@elizaos/plugin-personal-assistant")).toBe(
      true,
    );
    expect(serialPackages().has("@elizaos/plugin-agent-orchestrator")).toBe(
      true,
    );
    expect(serialPackages().has("@elizaos/plugin-sql")).toBe(true);
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
  test("defaults to 1 (fully serial) only when the value is absent", () => {
    for (const value of [undefined, null, ""]) {
      expect(normalizeConcurrency(value)).toBe(1);
    }
  });

  test("parses canonical positive integers from string or number", () => {
    expect(normalizeConcurrency("4")).toBe(4);
    expect(normalizeConcurrency(8)).toBe(8);
    expect(normalizeConcurrency(String(MAX_TASK_CONCURRENCY))).toBe(
      MAX_TASK_CONCURRENCY,
    );
  });

  test("throws on present-but-malformed values instead of degrading to serial", () => {
    // "1e3" and "8abc" used to silently become 1 and 8 via parseInt; "3.9"
    // used to truncate; zero/negative/overflow used to fall back to 1.
    for (const value of [
      "abc",
      "0",
      "-3",
      0,
      -1,
      "1e3",
      "8abc",
      "3.9",
      "08",
      " 4 ",
      "0x10",
      String(MAX_TASK_CONCURRENCY + 1),
      "999999",
    ]) {
      expect(() => normalizeConcurrency(value)).toThrow(/concurrency/);
    }
  });
});

describe("resolveConcurrency", () => {
  test("prefers the CLI value and treats blank environment values as absent", () => {
    expect(resolveConcurrency("4", "9")).toBe(4);
    expect(resolveConcurrency(null, undefined)).toBe(1);
    expect(resolveConcurrency(null, "")).toBe(1);
    expect(resolveConcurrency(null, "   ")).toBe(1);
    expect(resolveConcurrency(null, "5")).toBe(5);
  });

  test("rejects malformed present environment values", () => {
    expect(() => resolveConcurrency(null, "1e3")).toThrow(/concurrency/);
  });
});

describe("parseShardSpec", () => {
  test("parses a valid N/M spec", () => {
    expect(parseShardSpec("2/4")).toEqual({ index: 2, total: 4 });
    expect(parseShardSpec("1/1")).toEqual({ index: 1, total: 1 });
    expect(parseShardSpec("4/4")).toEqual({ index: 4, total: 4 });
    expect(parseShardSpec("02/04")).toEqual({ index: 2, total: 4 });
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
      "+1/4", // signed index
      "1/-4", // negative total
      "1/+4", // signed total
      "1/2/3", // too many parts
      "/4", // empty index
      "2/", // empty total
      "1junk/2", // partial index
      "1/2junk", // partial total
      "1.5/2", // decimal index
      "1/2.5", // decimal total
      "1e0/2", // exponent index
      "1/2e0", // exponent total
      " 1/2", // leading whitespace
      "1/2 ", // trailing whitespace
      "9007199254740992/9007199254740992", // unsafe index and total
      "1/9007199254740992", // unsafe total
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

describe("plugin test command contract", () => {
  const rootPackageJson = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
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
        TEST_CONCURRENCY: "",
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

  test("matches forward-slash filters when path.relative returns Windows separators", () => {
    const preloadSource = String.raw`
      import path from "node:path";
      const nativeJoin = path.join;
      const nativeRelative = path.relative;
      path.join = (...parts) => {
        const joined = nativeJoin(...parts);
        const repoPath = parts.join("/");
        return repoPath === "packages/cloud/e2e" || repoPath === "packages/homepage"
          ? joined.replaceAll("/", "\\")
          : joined;
      };
      path.relative = (from, to) => {
        const relativePath = nativeRelative(from, to);
        const caller = (new Error().stack ?? "").split("\n")[2] ?? "";
        if (caller.includes("run-all-tests.mjs")) {
          return relativePath.replaceAll("/", "\\");
        }
        return relativePath;
      };
    `;
    const runWindowsPlan = (...args: string[]) =>
      spawnSync(
        "node",
        [
          "--import",
          `data:text/javascript,${encodeURIComponent(preloadSource)}`,
          runnerPath.pathname,
          ...args,
        ],
        {
          cwd: new URL("../../..", import.meta.url).pathname,
          encoding: "utf8",
          env: {
            ...process.env,
            TEST_LANE: "pr",
            TEST_PACKAGE_FILTER: "",
            TEST_SCRIPT_FILTER: "",
            TEST_SHARD: "",
            TEST_START_AT: "",
            TEST_CONCURRENCY: "",
          },
        },
      );
    const result = runWindowsPlan(
      "--plan=json",
      "--only=test",
      "--no-cloud",
      "--filter=^@elizaos/core \\(packages/core\\)#test$",
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.tasks).toEqual([
      expect.objectContaining({
        packageName: "@elizaos/core",
        relativeDir: "packages/core",
        label: "@elizaos/core (packages/core)#test",
      }),
    ]);
    const skippedResult = runWindowsPlan(
      "--plan=json",
      "--only=e2e",
      "--no-cloud",
    );
    expect(skippedResult.stderr).toBe("");
    expect(skippedResult.status).toBe(0);
    expect(JSON.parse(skippedResult.stdout).skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativeDir: "packages/homepage",
          reason: "operator-run visual harness excluded from the pr lane",
        }),
      ]),
    );
  });

  test("warns and preserves the unsharded plan for a partially numeric TEST_SHARD", () => {
    const result = runPlan(
      [
        "--plan=json",
        "--only=test",
        "--no-cloud",
        "--filter=^@elizaos/core \\(packages/core\\)#test$",
      ],
      { TEST_SHARD: "1junk/2" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      'WARN invalid TEST_SHARD "1junk/2" — expected N/M (1-indexed). Ignoring.',
    );
    const plan = JSON.parse(result.stdout);
    expect(plan.summary).toMatchObject({ shard: null, taskCount: 1 });
    expect(plan.tasks).toEqual([
      expect.objectContaining({
        packageName: "@elizaos/core",
        relativeDir: "packages/core",
        scriptName: "test",
      }),
    ]);
  });

  test("keeps the source-only homepage visual harness out of root PR smoke", () => {
    const prResult = runPlan([
      "--plan=json",
      "--only=e2e",
      "--filter=^@elizaos/homepage-source \\(packages/homepage\\)#test:e2e$",
    ]);
    expect(prResult.status).toBe(0);
    expect(JSON.parse(prResult.stdout).tasks).toEqual([]);
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
