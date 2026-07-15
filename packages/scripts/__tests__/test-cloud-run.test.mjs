/**
 * Exercises the pure batch-orchestration helpers in test-cloud-run.mjs
 * (walkTests, chunkByBudget, formatBatchFiles, writeSyncAll) and the
 * clean-install preflight (ensureCloudTestRuntime, runPreflightStep) directly,
 * without driving the side-effecting `main()` (which shells out to `bun
 * test`). Those side effects are covered end-to-end by the `test:cloud` CI
 * lane instead.
 */
import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTestEnv,
  chunkByBudget,
  computeRequiredRuntimeArtifacts,
  computeTestRoots,
  EXCLUDED_DIRS,
  ensureCloudTestRuntime,
  findMissingRoots,
  formatBatchFiles,
  PREFLIGHT_STEPS,
  runBatches,
  runPreflightStep,
  walkTests,
  writeSyncAll,
} from "../test-cloud-run.mjs";

describe("walkTests", () => {
  it("finds .test. and .spec. files recursively and skips excluded dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "test-cloud-run-walk-"));
    try {
      writeFileSync(join(root, "a.test.ts"), "");
      writeFileSync(join(root, "b.spec.tsx"), "");
      writeFileSync(join(root, "c.ts"), ""); // not a test file, must be skipped
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "nested", "d.test.ts"), "");
      mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(root, "node_modules", "pkg", "e.test.ts"), "");

      const found = walkTests(root, EXCLUDED_DIRS).sort();

      expect(found).toEqual(
        [
          join(root, "a.test.ts"),
          join(root, "b.spec.tsx"),
          join(root, "nested", "d.test.ts"),
        ].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("chunkByBudget", () => {
  it("closes a batch once the file-count limit is hit", () => {
    const files = ["a", "b", "c", "d", "e"];
    const batches = chunkByBudget(files, 2, 100000);
    expect(batches).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("closes a batch once the char budget is hit", () => {
    // Each entry costs length+1; budget 5 fits "aa"(3) then closes before "bb".
    const files = ["aa", "bb", "cc"];
    const batches = chunkByBudget(files, 80, 5);
    expect(batches).toEqual([["aa"], ["bb"], ["cc"]]);
  });

  it("returns a single batch when nothing exceeds the budget", () => {
    const files = ["x", "y", "z"];
    const batches = chunkByBudget(files, 80, 100000);
    expect(batches).toEqual([["x", "y", "z"]]);
  });

  it("returns no batches for an empty file list", () => {
    expect(chunkByBudget([], 80, 100000)).toEqual([]);
  });
});

describe("formatBatchFiles", () => {
  it("renders each file as a repo-relative bullet", () => {
    const root = "/repo";
    const batch = ["/repo/packages/a/x.test.ts", "/repo/packages/b/y.spec.ts"];
    expect(formatBatchFiles(batch, root)).toBe(
      "  - packages/a/x.test.ts\n  - packages/b/y.spec.ts",
    );
  });
});

describe("writeSyncAll", () => {
  it("writes the full payload to the given fd even across multiple internal writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-cloud-run-write-"));
    const file = join(dir, "out.txt");
    try {
      const fd = openSync(file, "w");
      const payload = "x".repeat(200_000); // large enough to require several writeSync calls
      writeSyncAll(fd, payload);

      const buffer = Buffer.alloc(payload.length);
      const readFd = openSync(file, "r");
      let readTotal = 0;
      while (readTotal < buffer.length) {
        const n = readSync(
          readFd,
          buffer,
          readTotal,
          buffer.length - readTotal,
          readTotal,
        );
        if (n === 0) break;
        readTotal += n;
      }
      expect(readTotal).toBe(payload.length);
      expect(buffer.toString("utf8")).toBe(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op for empty input", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-cloud-run-write-empty-"));
    const file = join(dir, "out.txt");
    try {
      const fd = openSync(file, "w");
      writeSyncAll(fd, "");
      writeSyncAll(fd, undefined);
      expect(() => writeSyncAll(fd, "")).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildTestEnv", () => {
  it("pins the unit lane to in-process PGlite and skips the DB/server checks", () => {
    const env = buildTestEnv({
      PATH: "/usr/bin",
      DATABASE_URL: "postgresql://real-db",
    });
    expect(env.PATH).toBe("/usr/bin"); // preserves the base env
    expect(env.DATABASE_URL).toBe("pglite://memory"); // overrides any ambient real DB URL
    expect(env.TEST_DATABASE_URL).toBe("pglite://memory");
    expect(env.SKIP_DB_DEPENDENT).toBe("1");
    expect(env.SKIP_SERVER_CHECK).toBe("true");
  });
});

describe("computeTestRoots", () => {
  it("derives every test root from the repo root", () => {
    const roots = computeTestRoots("/repo");
    expect(roots).toEqual({
      cloudSharedSrc: join("/repo", "packages", "cloud", "shared", "src"),
      cloudApiRoot: join("/repo", "packages", "cloud", "api"),
      cloudScriptsTests: join("/repo", "packages", "scripts", "cloud"),
      cloudRoutingTests: join("/repo", "packages", "cloud", "routing", "src"),
      cloudInfraTests: join("/repo", "packages", "cloud", "infra", "tests"),
      cloudServicesRoot: join("/repo", "packages", "cloud", "services"),
    });
  });
});

describe("findMissingRoots", () => {
  it("reports only the roots the injected existsFn says are absent", () => {
    const roots = { a: "/repo/a", b: "/repo/b", c: "/repo/c" };
    const missing = findMissingRoots(roots, (dir) => dir !== "/repo/b");
    expect(missing).toEqual(["b -> /repo/b"]);
  });

  it("returns an empty list when every root exists", () => {
    const roots = { a: "/repo/a" };
    expect(findMissingRoots(roots, () => true)).toEqual([]);
  });
});

describe("ensureCloudTestRuntime", () => {
  const artifacts = computeRequiredRuntimeArtifacts("/repo");

  it("runs nothing on a fully built tree", () => {
    const ran = [];
    ensureCloudTestRuntime({
      requiredArtifacts: artifacts,
      steps: PREFLIGHT_STEPS,
      existsFn: () => true,
      runStep: (step) => ran.push(step.label),
      log: () => {},
    });
    expect(ran).toEqual([]);
  });

  it("on a clean install runs the keyword codegen before build:core and logs the missing paths", () => {
    const ran = [];
    const logs = [];
    const created = new Set();
    ensureCloudTestRuntime({
      requiredArtifacts: artifacts,
      steps: PREFLIGHT_STEPS,
      existsFn: (file) => created.has(file),
      runStep: (step) => {
        ran.push(step.label);
        const key = Object.entries(PREFLIGHT_STEPS).find(
          ([, candidate]) => candidate === step,
        )[0];
        for (const file of artifacts[key]) created.add(file);
      },
      log: (text) => logs.push(text),
    });
    expect(ran).toEqual([
      PREFLIGHT_STEPS.keywordCodegen.label,
      PREFLIGHT_STEPS.coreBuild.label,
    ]);
    expect(logs.join("")).toContain("missing runtime artifact");
  });

  it("runs only the codegen when a turbo cache hit restored dist without the generated modules", () => {
    const ran = [];
    let generated = false;
    ensureCloudTestRuntime({
      requiredArtifacts: artifacts,
      steps: PREFLIGHT_STEPS,
      existsFn: (file) =>
        artifacts.coreBuild.includes(file) ? true : generated,
      runStep: (step) => {
        ran.push(step.label);
        generated = true;
      },
      log: () => {},
    });
    expect(ran).toEqual([PREFLIGHT_STEPS.keywordCodegen.label]);
  });

  it("fails loudly when a step completes without producing its artifacts", () => {
    expect(() =>
      ensureCloudTestRuntime({
        requiredArtifacts: artifacts,
        steps: PREFLIGHT_STEPS,
        existsFn: () => false,
        runStep: () => {},
        log: () => {},
      }),
    ).toThrow(/still missing/);
  });

  it("rejects an artifact group with no matching step instead of skipping it", () => {
    expect(() =>
      ensureCloudTestRuntime({
        requiredArtifacts: { orphanGroup: ["/repo/nope"] },
        steps: PREFLIGHT_STEPS,
        existsFn: () => false,
        runStep: () => {},
        log: () => {},
      }),
    ).toThrow(/no preflight step named "orphanGroup"/);
  });
});

describe("runPreflightStep", () => {
  it("spawns the step script from the repo root with inherited stdio", () => {
    let spawned;
    runPreflightStep(PREFLIGHT_STEPS.coreBuild, {
      repoRoot: "/repo",
      spawnFn: (cmd, args, opts) => {
        spawned = { cmd, args, opts };
        return { status: 0, signal: null };
      },
    });
    expect(spawned.cmd).toBe(process.execPath);
    expect(spawned.args[0]).toBe(
      join("/repo", "packages", "scripts", "build-core.mjs"),
    );
    expect(spawned.opts.cwd).toBe("/repo");
    expect(spawned.opts.stdio).toBe("inherit");
  });

  it("throws a loud diagnostic naming the step and exit code on failure", () => {
    expect(() =>
      runPreflightStep(PREFLIGHT_STEPS.coreBuild, {
        repoRoot: "/repo",
        spawnFn: () => ({ status: 1, signal: null }),
      }),
    ).toThrow(/core workspace build \(build:core\) failed \(exit 1\)/);
  });

  it("reports the signal when the step was killed", () => {
    expect(() =>
      runPreflightStep(PREFLIGHT_STEPS.keywordCodegen, {
        repoRoot: "/repo",
        spawnFn: () => ({ status: null, signal: "SIGTERM" }),
      }),
    ).toThrow(/failed \(signal SIGTERM\)/);
  });

  it("surfaces a spawn error as could-not-start", () => {
    expect(() =>
      runPreflightStep(PREFLIGHT_STEPS.keywordCodegen, {
        repoRoot: "/repo",
        spawnFn: () => ({
          error: new Error("spawn ENOENT"),
          status: null,
          signal: null,
        }),
      }),
    ).toThrow(/could not start i18n keyword codegen/);
  });
});

describe("runBatches", () => {
  function collector() {
    const lines = [];
    return { lines, write: (text) => lines.push(text) };
  }

  it("returns false and keeps going when every batch passes", () => {
    const out = collector();
    const err = collector();
    const calls = [];
    const anyFailed = runBatches([["a.test.ts"], ["b.test.ts"]], {
      spawnBatch: (batch) => {
        calls.push(batch);
        return { status: 0, signal: null, stdout: "ok\n", stderr: "" };
      },
      stagingDir: "/staging",
      env: {},
      repoRoot: "/repo",
      writeOut: out.write,
      writeErr: err.write,
    });
    expect(anyFailed).toBe(false);
    expect(calls).toEqual([["a.test.ts"], ["b.test.ts"]]);
    expect(out.lines.join("")).toContain("batch 1/2");
    expect(out.lines.join("")).toContain("ok\n");
  });

  it("marks the gate failed and reports the offending files on a real failure", () => {
    const out = collector();
    const err = collector();
    const anyFailed = runBatches([["/repo/packages/x/a.test.ts"]], {
      spawnBatch: () => ({
        status: 1,
        signal: null,
        stdout: "1 fail\n",
        stderr: "(fail) something broke\n",
      }),
      stagingDir: "/staging",
      env: {},
      repoRoot: "/repo",
      writeOut: out.write,
      writeErr: err.write,
    });
    expect(anyFailed).toBe(true);
    expect(err.lines.join("")).toContain("exited non-zero");
    expect(err.lines.join("")).toContain("packages/x/a.test.ts");
  });

  it("normalizes the known Bun/PGlite status-99 pollution as a pass", () => {
    const out = collector();
    const err = collector();
    const anyFailed = runBatches([["a.test.ts"]], {
      spawnBatch: () => ({
        status: 99,
        signal: null,
        stdout: "Ran 3 tests across 1 file.\n",
        stderr: "",
      }),
      stagingDir: "/staging",
      env: {},
      repoRoot: "/repo",
      writeOut: out.write,
      writeErr: err.write,
    });
    expect(anyFailed).toBe(false);
    expect(err.lines.join("")).toContain("treating as pass");
  });

  it("stops immediately and reports a spawn error", () => {
    const out = collector();
    const err = collector();
    const anyFailed = runBatches([["a.test.ts"], ["b.test.ts"]], {
      spawnBatch: () => ({ error: new Error("spawn bun ENOENT") }),
      stagingDir: "/staging",
      env: {},
      repoRoot: "/repo",
      writeOut: out.write,
      writeErr: err.write,
    });
    expect(anyFailed).toBe(true);
    expect(err.lines.join("")).toContain("spawn error");
    expect(err.lines.join("")).toContain("ENOENT");
  });
});
