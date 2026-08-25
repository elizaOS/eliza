/**
 * Exercises the pure batch-orchestration helpers in test-cloud-run.mjs
 * (walkTests, chunkByBudget, formatBatchFiles, writeSyncAll) and the
 * clean-install preflight (ensureCloudTestRuntime, runPreflightStep) directly,
 * without driving the side-effecting `main()` (which shells out to `bun
 * test`). Those side effects are covered end-to-end by the `test:cloud` CI
 * lane instead.
 */
import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
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
import { PassThrough } from "node:stream";
import {
  appendClassificationOutput,
  buildTestEnv,
  chunkByBudget,
  computeRequiredRuntimeArtifacts,
  computeTestRoots,
  EXCLUDED_DIRS,
  ensureCloudTestRuntime,
  findMissingRoots,
  formatBatchFiles,
  MAX_CLASSIFICATION_OUTPUT_CHARS,
  MAX_FILES_PER_BATCH_WIN32,
  PREFLIGHT_STEPS,
  parseBatchTimeoutArg,
  parsePositiveDuration,
  readProcessIdentity,
  runBatches,
  runCommandWithWatchdog,
  runPreflightStep,
  terminateProcessTree,
  walkTests,
  windowsTaskkillInvocation,
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

  it("bounds Windows process lifetime for native and PGlite-heavy suites", () => {
    const files = Array.from({ length: 40 }, (_, index) => `test-${index}.ts`);
    const batches = chunkByBudget(files, MAX_FILES_PER_BATCH_WIN32, 100000);

    expect(batches.map((batch) => batch.length)).toEqual([16, 16, 8]);
  });
});

describe("formatBatchFiles", () => {
  it("renders each file as a repo-relative bullet", () => {
    const root = "/repo";
    const batch = ["/repo/packages/a/x.test.ts", "/repo/packages/b/y.spec.ts"];
    expect(formatBatchFiles(batch, root)).toBe(
      `  - ${join("packages", "a", "x.test.ts")}\n  - ${join("packages", "b", "y.spec.ts")}`,
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
      cloudScriptsTests: join("/repo", "packages", "cloud", "scripts"),
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

  it("prints the exact manifest before spawning and keeps going when every batch passes", async () => {
    const out = collector();
    const err = collector();
    const calls = [];
    const events = [];
    const anyFailed = await runBatches(
      [["/repo/a.test.ts"], ["/repo/b.test.ts"]],
      {
        spawnBatch: (batch) => {
          events.push(`spawn:${batch[0]}`);
          calls.push(batch);
          return { status: 0, signal: null, stdout: "ok\n", stderr: "" };
        },
        stagingDir: "/staging",
        env: {},
        repoRoot: "/repo",
        writeOut: (text) => {
          events.push(`out:${text}`);
          out.write(text);
        },
        writeErr: err.write,
      },
    );
    expect(anyFailed).toBe(false);
    expect(calls).toEqual([["/repo/a.test.ts"], ["/repo/b.test.ts"]]);
    expect(out.lines.join("")).toContain("batch 1/2");
    expect(out.lines.join("")).toContain("files in batch:\n  - a.test.ts");
    expect(out.lines.join("")).toContain("ok\n");
    expect(
      events.findIndex((event) => event.includes("  - a.test.ts")),
    ).toBeLessThan(events.indexOf("spawn:/repo/a.test.ts"));
  });

  it("collects ordinary failures and reports the offending files", async () => {
    const out = collector();
    const err = collector();
    const calls = [];
    const anyFailed = await runBatches(
      [["/repo/packages/x/a.test.ts"], ["/repo/packages/y/b.test.ts"]],
      {
        spawnBatch: (batch) => {
          calls.push(batch);
          return calls.length === 1
            ? {
                status: 1,
                signal: null,
                stdout: "1 fail\n",
                stderr: "(fail) something broke\n",
              }
            : { status: 0, signal: null };
        },
        stagingDir: "/staging",
        env: {},
        repoRoot: "/repo",
        writeOut: out.write,
        writeErr: err.write,
      },
    );
    expect(anyFailed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(err.lines.join("")).toContain("exited non-zero");
    expect(err.lines.join("")).toContain(join("packages", "x", "a.test.ts"));
  });

  it("normalizes the known Bun/PGlite status-99 pollution from complete streamed output", async () => {
    const out = collector();
    const err = collector();
    const anyFailed = await runBatches([["a.test.ts"]], {
      spawnBatch: (_batch, { writeOut }) => {
        writeOut("Ran 3 tests across 1 file.\n");
        return {
          status: 99,
          signal: null,
          stdout: "Ran 3 tests across 1 file.\n",
          stderr: "",
          streamed: true,
        };
      },
      stagingDir: "/staging",
      env: {},
      repoRoot: "/repo",
      writeOut: out.write,
      writeErr: err.write,
    });
    expect(anyFailed).toBe(false);
    expect(err.lines.join("")).toContain("treating as pass");
  });

  it("does not normalize status 99 when bounded classification output was truncated", async () => {
    const out = collector();
    const err = collector();
    const anyFailed = await runBatches([["a.test.ts"]], {
      spawnBatch: () => ({
        status: 99,
        signal: null,
        stdout: "Ran 3 tests across 1 file.\n",
        stderr: "",
        streamed: true,
        outputTruncated: true,
      }),
      stagingDir: "/staging",
      env: {},
      repoRoot: "/repo",
      writeOut: out.write,
      writeErr: err.write,
    });
    expect(anyFailed).toBe(true);
    expect(err.lines.join("")).toContain("exited non-zero");
    expect(err.lines.join("")).not.toContain("treating as pass");
  });

  it("stops when process-tree teardown fails", async () => {
    const out = collector();
    const err = collector();
    const calls = [];
    const anyFailed = await runBatches([["a.test.ts"], ["b.test.ts"]], {
      spawnBatch: (batch) => {
        calls.push(batch);
        return { terminationError: new Error("taskkill failed") };
      },
      stagingDir: "/staging",
      env: {},
      repoRoot: "/repo",
      writeOut: out.write,
      writeErr: err.write,
    });
    expect(anyFailed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(err.lines.join("")).toContain("process-tree teardown failed");
  });

  it("continues after a successfully reaped timeout and reports its deadline and files", async () => {
    const out = collector();
    const err = collector();
    const calls = [];
    const anyFailed = await runBatches(
      [["/repo/a.test.ts"], ["/repo/b.test.ts"]],
      {
        spawnBatch: (batch, { onTimeout }) => {
          calls.push(batch);
          if (calls.length === 1) {
            onTimeout();
            return { timedOut: true, status: null, signal: "SIGKILL" };
          }
          return { status: 0, signal: null };
        },
        stagingDir: "/staging",
        env: {},
        repoRoot: "/repo",
        writeOut: out.write,
        writeErr: err.write,
        timeoutMs: 4321,
      },
    );
    expect(anyFailed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(err.lines.join("")).toContain("4321 ms wall-clock deadline");
    expect(err.lines.join("")).toContain(
      "files in timed-out batch:\n  - a.test.ts",
    );
  });

  it("stops immediately and reports a spawn error", async () => {
    const out = collector();
    const err = collector();
    const calls = [];
    const anyFailed = await runBatches([["a.test.ts"], ["b.test.ts"]], {
      spawnBatch: (batch) => {
        calls.push(batch);
        return { error: new Error("spawn bun ENOENT") };
      },
      stagingDir: "/staging",
      env: {},
      repoRoot: "/repo",
      writeOut: out.write,
      writeErr: err.write,
    });
    expect(anyFailed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(err.lines.join("")).toContain("spawn error");
    expect(err.lines.join("")).toContain("ENOENT");
  });
});

describe("watchdog configuration", () => {
  it("accepts positive millisecond values and rejects invalid timers", () => {
    expect(parsePositiveDuration(undefined, "TIMEOUT", 50)).toBe(50);
    expect(parsePositiveDuration("250", "TIMEOUT", 50)).toBe(250);
    for (const value of ["0", "-1", "1.5", "1e3", " 10", "2147483648"]) {
      expect(() => parsePositiveDuration(value, "TIMEOUT", 50)).toThrow(
        /TIMEOUT must be/,
      );
    }
  });

  it("parses the optional batch timeout CLI argument", () => {
    expect(parseBatchTimeoutArg([])).toBe(600_000);
    expect(parseBatchTimeoutArg(["--batch-timeout-ms=250"])).toBe(250);
    expect(() =>
      parseBatchTimeoutArg([
        "--batch-timeout-ms=250",
        "--batch-timeout-ms=500",
      ]),
    ).toThrow(/only once/);
    expect(() => parseBatchTimeoutArg(["--unknown"])).toThrow(
      /unexpected argument/,
    );
    expect(() => parseBatchTimeoutArg(["--batch-timeout-ms="])).toThrow(
      /must include a positive integer value/,
    );
  });

  it("builds soft and forced Windows whole-tree taskkill commands", () => {
    expect(windowsTaskkillInvocation(321, false)).toEqual({
      command: "taskkill",
      args: ["/PID", "321", "/T"],
    });
    expect(windowsTaskkillInvocation(321, true)).toEqual({
      command: "taskkill",
      args: ["/PID", "321", "/T", "/F"],
    });
  });

  it("captures Windows process identity through the bounded Get-Process path", () => {
    let invocation;
    const identity = readProcessIdentity(321, {
      platform: "win32",
      spawnSyncFn: (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0, stdout: "638915887234567890" };
      },
    });

    expect(identity).toBe("win-creation:638915887234567890");
    expect(invocation.command).toBe("powershell.exe");
    expect(invocation.args).toContain("-NoProfile");
    expect(invocation.args.at(-1)).toContain("Get-Process -Id 321");
    expect(invocation.args.at(-1)).not.toContain("Get-CimInstance");
    expect(invocation.options).toMatchObject({
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4096,
    });
  });

  it("rejects missing or malformed Windows process identities", () => {
    for (const result of [
      { status: 3, stdout: "" },
      { status: 0, stdout: "not-ticks" },
      { status: 0, stdout: "" },
      { status: 0, stdout: "123\n456" },
      { status: 0, stdout: "123", error: new Error("timed out") },
    ]) {
      expect(
        readProcessIdentity(321, {
          platform: "win32",
          spawnSyncFn: () => result,
        }),
      ).toBeUndefined();
    }

    expect(
      readProcessIdentity(321, {
        platform: "win32",
        spawnSyncFn: () => {
          throw new Error("PowerShell unavailable");
        },
      }),
    ).toBeUndefined();
  });

  it("signals the POSIX process group with TERM then KILL", async () => {
    const signals = [];
    await terminateProcessTree(321, {
      platform: "darwin",
      graceMs: 1,
      signalFn: (pid, signal) => signals.push([pid, signal]),
      delayFn: async () => {},
      identityFn: () => "original-process",
      processGroupFn: () => 321,
    });
    expect(signals).toEqual([
      [321, "SIGSTOP"],
      [-321, "SIGTERM"],
      [-321, "SIGKILL"],
    ]);
  });

  it("normalizes Windows taskkill races when the tree is already gone", async () => {
    const runWithCodes = async (codes) => {
      const invocations = [];
      await terminateProcessTree(321, {
        platform: "win32",
        graceMs: 1,
        delayFn: async () => {},
        identityFn: () => "original-process",
        spawnFn: (command, args) => {
          invocations.push([command, args]);
          const killer = new EventEmitter();
          killer.kill = () => {};
          queueMicrotask(() => killer.emit("close", codes.shift(), null));
          return killer;
        },
      });
      return invocations;
    };

    expect(await runWithCodes([128, 128])).toHaveLength(2);
    expect(await runWithCodes([0, 128])).toHaveLength(2);
    expect(await runWithCodes([5, 0])).toHaveLength(2);
  });

  it("does not force-kill a replacement Windows PID after a soft pass", async () => {
    const identities = ["original-process", "replacement-process"];
    const invocations = [];
    await expect(
      terminateProcessTree(321, {
        platform: "win32",
        graceMs: 1,
        delayFn: async () => {},
        identityFn: () => identities.shift(),
        spawnFn: (command, args) => {
          invocations.push([command, args]);
          const killer = new EventEmitter();
          killer.kill = () => {};
          queueMicrotask(() => killer.emit("close", 0, null));
          return killer;
        },
      }),
    ).rejects.toMatchObject({ code: "PROCESS_IDENTITY_UNPROVEN" });
    expect(invocations).toEqual([["taskkill", ["/PID", "321", "/T"]]]);
  });

  it("does not force-kill a POSIX group after the supervisor identity changes", async () => {
    const identities = [
      "original-group",
      "original-group",
      "replacement-group",
    ];
    const signals = [];
    await expect(
      terminateProcessTree(321, {
        platform: "darwin",
        graceMs: 1,
        delayFn: async () => {},
        identityFn: () => identities.shift(),
        processGroupFn: () => 321,
        signalFn: (pid, signal) => signals.push([pid, signal]),
      }),
    ).rejects.toMatchObject({ code: "PROCESS_IDENTITY_UNPROVEN" });
    expect(signals).toEqual([
      [321, "SIGSTOP"],
      [-321, "SIGTERM"],
    ]);
  });

  it("fails closed when supervisor PGID ownership changes during grace", async () => {
    const processGroups = [321, 321, 999];
    const signals = [];
    await expect(
      terminateProcessTree(321, {
        platform: "darwin",
        graceMs: 1,
        delayFn: async () => {},
        identityFn: () => "original-process",
        processGroupFn: () => processGroups.shift(),
        signalFn: (pid, signal) => signals.push([pid, signal]),
      }),
    ).rejects.toMatchObject({ code: "PROCESS_GROUP_UNPROVEN" });
    expect(signals).toEqual([
      [321, "SIGSTOP"],
      [-321, "SIGTERM"],
    ]);
  });

  it("fails closed when supervisor identity changes as it is stopped", async () => {
    const identities = ["original-process", "replacement-process"];
    const signals = [];
    await expect(
      terminateProcessTree(321, {
        platform: "darwin",
        graceMs: 1,
        delayFn: async () => {},
        identityFn: () => identities.shift(),
        processGroupFn: () => 321,
        signalFn: (pid, signal) => signals.push([pid, signal]),
      }),
    ).rejects.toMatchObject({ code: "PROCESS_IDENTITY_UNPROVEN" });
    expect(signals).toEqual([[321, "SIGSTOP"]]);
  });

  it("fails closed when supervisor PGID ownership changes as it is stopped", async () => {
    const processGroups = [321, 999];
    const signals = [];
    await expect(
      terminateProcessTree(321, {
        platform: "darwin",
        graceMs: 1,
        delayFn: async () => {},
        identityFn: () => "original-process",
        processGroupFn: () => processGroups.shift(),
        signalFn: (pid, signal) => signals.push([pid, signal]),
      }),
    ).rejects.toMatchObject({ code: "PROCESS_GROUP_UNPROVEN" });
    expect(signals).toEqual([[321, "SIGSTOP"]]);
  });

  it("never stops a process that is not the detached group leader", async () => {
    const signals = [];
    await expect(
      terminateProcessTree(321, {
        platform: "darwin",
        graceMs: 1,
        delayFn: async () => {},
        identityFn: () => "original-process",
        processGroupFn: () => 999,
        signalFn: (pid, signal) => signals.push([pid, signal]),
      }),
    ).rejects.toMatchObject({ code: "PROCESS_GROUP_UNPROVEN" });
    expect(signals).toEqual([]);
  });

  it("spawns POSIX commands behind an owned process-group supervisor", async () => {
    const signalSource = new EventEmitter();
    const child = new EventEmitter();
    child.pid = 321;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const supervisorStatus = new PassThrough();
    const supervisorControl = new PassThrough();
    child.stdio = [
      null,
      child.stdout,
      child.stderr,
      supervisorStatus,
      supervisorControl,
    ];
    let supervisorRelease = "";
    supervisorControl.on("data", (chunk) => {
      supervisorRelease += chunk.toString("utf8");
    });
    let spawned;
    const resultPromise = runCommandWithWatchdog("bun", ["test", "a.ts"], {
      timeoutMs: 10_000,
      writeOut: () => {},
      writeErr: () => {},
      platform: "darwin",
      signalSource,
      identityFn: () => "supervisor",
      spawnFn: (command, args, options) => {
        spawned = { command, args, options };
        return child;
      },
    });

    supervisorStatus.end("0\n");
    child.stdout.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(supervisorRelease).toBe("");
    child.stderr.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(supervisorRelease).toBe("release\n");
    child.emit("close", 0, null);
    const result = await resultPromise;

    expect(spawned.command).toBe("/bin/sh");
    expect(spawned.args.slice(-3)).toEqual(["bun", "test", "a.ts"]);
    expect(spawned.args[0]).toBe("-c");
    expect(spawned.args[1]).toContain("trap 'terminating=1' TERM INT");
    expect(spawned.args[1]).toContain("read -r release <&4");
    expect(spawned.options.detached).toBe(true);
    expect(spawned.options.stdio).toHaveLength(5);
    expect(result.status).toBe(0);
  });

  it("fails closed when forced Windows tree termination fails", async () => {
    const codes = [0, 5];
    await expect(
      terminateProcessTree(321, {
        platform: "win32",
        graceMs: 1,
        delayFn: async () => {},
        identityFn: () => "original-process",
        spawnFn: () => {
          const killer = new EventEmitter();
          killer.kill = () => {};
          queueMicrotask(() => killer.emit("close", codes.shift(), null));
          return killer;
        },
      }),
    ).rejects.toThrow(/failed to terminate Windows process tree/);
  });

  it("tears down the active child and removes listeners on a parent signal", async () => {
    const signalSource = new EventEmitter();
    const child = new EventEmitter();
    child.pid = 321;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const terminations = [];
    const resultPromise = runCommandWithWatchdog("bun", ["test"], {
      timeoutMs: 10_000,
      writeOut: () => {},
      writeErr: () => {},
      signalSource,
      spawnFn: () => child,
      terminateTree: async (pid) => {
        terminations.push(pid);
        child.emit("close", null, "SIGTERM");
      },
    });

    signalSource.emit("SIGTERM");
    const result = await resultPromise;

    expect(result.parentSignal).toBe("SIGTERM");
    expect(terminations).toEqual([321]);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("keeps the first termination cause when a parent signal races a timeout", async () => {
    const signalSource = new EventEmitter();
    const child = new EventEmitter();
    child.pid = 321;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let releaseTermination;
    const terminationStarted = new Promise((resolve) => {
      releaseTermination = resolve;
    });
    let unblockTermination;
    const terminationBlocked = new Promise((resolve) => {
      unblockTermination = resolve;
    });
    const resultPromise = runCommandWithWatchdog("bun", ["test"], {
      timeoutMs: 1,
      writeOut: () => {},
      writeErr: () => {},
      signalSource,
      spawnFn: () => child,
      terminateTree: async () => {
        releaseTermination();
        await terminationBlocked;
        child.emit("close", null, "SIGKILL");
      },
    });

    await terminationStarted;
    signalSource.emit("SIGTERM");
    unblockTermination();
    const result = await resultPromise;

    expect(result.timedOut).toBe(true);
    expect(result.parentSignal).toBeUndefined();
  });

  it("keeps a parent signal as the cause when its teardown crosses the deadline", async () => {
    const signalSource = new EventEmitter();
    const child = new EventEmitter();
    child.pid = 321;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let unblockTermination;
    const terminationBlocked = new Promise((resolve) => {
      unblockTermination = resolve;
    });
    const resultPromise = runCommandWithWatchdog("bun", ["test"], {
      timeoutMs: 1,
      writeOut: () => {},
      writeErr: () => {},
      signalSource,
      spawnFn: () => child,
      terminateTree: async () => {
        await terminationBlocked;
        child.emit("close", null, "SIGTERM");
      },
    });

    signalSource.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 5));
    unblockTermination();
    const result = await resultPromise;

    expect(result.parentSignal).toBe("SIGTERM");
    expect(result.timedOut).toBe(false);
  });

  it("retains the POSIX supervisor until completed-command output drains", async () => {
    const signalSource = new EventEmitter();
    const child = new EventEmitter();
    child.pid = 321;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const supervisorStatus = new PassThrough();
    const supervisorControl = new PassThrough();
    child.stdio = [
      null,
      child.stdout,
      child.stderr,
      supervisorStatus,
      supervisorControl,
    ];
    let supervisorRelease = "";
    supervisorControl.on("data", (chunk) => {
      supervisorRelease += chunk.toString("utf8");
    });
    let terminationCalls = 0;
    const resultPromise = runCommandWithWatchdog("bun", ["test"], {
      timeoutMs: 1,
      writeOut: () => {},
      writeErr: () => {},
      platform: "darwin",
      signalSource,
      spawnFn: () => child,
      terminateTree: async () => {
        terminationCalls += 1;
        child.emit("close", null, "SIGKILL");
      },
    });

    supervisorStatus.end("0\n");
    child.stdout.end();
    const result = await resultPromise;

    expect(terminationCalls).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    expect(supervisorRelease).toBe("");
  });

  it("fails closed instead of taskkilling a reused Windows leader PID", async () => {
    const signalSource = new EventEmitter();
    const child = new EventEmitter();
    child.pid = 321;
    child.exitCode = 0;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let terminationCalls = 0;
    const result = await runCommandWithWatchdog("bun", ["test"], {
      timeoutMs: 1,
      writeOut: () => {},
      writeErr: () => {},
      platform: "win32",
      signalSource,
      spawnFn: () => child,
      terminateTree: async () => {
        terminationCalls += 1;
      },
    });

    expect(terminationCalls).toBe(0);
    expect(result.timedOut).toBe(true);
    expect(result.terminationError?.message).toContain(
      "process-tree teardown cannot be proven safely",
    );
  });

  it("retains only a bounded output tail for status classification", () => {
    const oversized = "x".repeat(MAX_CLASSIFICATION_OUTPUT_CHARS + 20);
    const retained = appendClassificationOutput(
      "prefix",
      `${oversized}STATUS99`,
    );
    expect(retained).toHaveLength(MAX_CLASSIFICATION_OUTPUT_CHARS);
    expect(retained.endsWith("STATUS99")).toBe(true);
    expect(retained.startsWith("prefix")).toBe(false);
  });
});
