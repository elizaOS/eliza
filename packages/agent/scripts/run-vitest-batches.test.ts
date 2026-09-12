/** Tests the real batch runner with deterministic file discovery, fake child processes, and filesystem evidence reconciliation. */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import {
  createBatches,
  createBunTestInvocation,
  createRunnerBatches,
  createVitestInvocation,
  isBunRuntimeTest,
  mergeAgentJunit,
  parseAgentTestArgs,
  positiveInteger,
  resolveBunExecutable,
} from "./run-vitest-batches.mjs";

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "agent-test-runner-"));
const runnerPath = fileURLToPath(
  new URL("./run-vitest-batches.mjs", import.meta.url),
);
const packageRoot = path.dirname(path.dirname(runnerPath));

function runFakeBatches(
  args: string[],
  options: {
    signal?: "SIGINT" | "SIGTERM";
    repeatSignal?: boolean;
    stubbornChildren?: boolean;
    failFirst?: boolean;
    batchSize?: number;
  } = {},
) {
  const preload = `
    import childProcess from "node:child_process";
    import fs from "node:fs";
    import { EventEmitter } from "node:events";
    import { syncBuiltinESMExports } from "node:module";
    import path from "node:path";
    const root = ${JSON.stringify(packageRoot)};
    const options = ${JSON.stringify(options)};
    const inventory = new Map([
      [path.join(root, "src"), ["a.test.ts", "b.test.ts", "c.test.ts", "excluded.live.test.ts", "not-a-test.ts"]],
      [path.join(root, "test"), ["crash-restart-supervisor.test.ts"]],
      [path.join(root, "scripts"), ["mobile-workspace-entry.test.mjs", "mobile-workspace-entry.mjs"]],
    ]);
    const readDirectory = fs.readdirSync;
    const stat = fs.statSync;
    fs.readdirSync = (directory, ...rest) => inventory.get(directory) ?? readDirectory(directory, ...rest);
    fs.statSync = (file, ...rest) => inventory.get(path.dirname(file))?.includes(path.basename(file))
      ? { isFile: () => true, isDirectory: () => false }
      : stat(file, ...rest);
    const children = new Map();
    const spawned = [];
    const runners = [];
    const killed = [];
    childProcess.spawn = (command, childArgs) => {
      const child = new EventEmitter();
      child.pid = 900000 + spawned.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      let closed = false;
      child.finish = (status, signal) => {
        if (closed) return;
        closed = true;
        children.delete(child.pid);
        child.emit("close", status, signal);
      };
      child.kill = (signal) => {
        killed.push({ pid: child.pid, signal });
        if (!options.stubbornChildren || signal === "SIGKILL") queueMicrotask(() => child.finish(null, signal));
        return true;
      };
      children.set(child.pid, child);
      const isBunTest = childArgs[0] === "test";
      runners.push(isBunTest ? "bun test" : childArgs.slice(0, 3).join(" "));
      spawned.push((isBunTest ? childArgs.slice(1) : childArgs.slice(5))
        .filter((arg) => !arg.startsWith("--"))
        .map((file) => file.split(path.sep).join("/")));
      if (options.signal && spawned.length === 2) {
        queueMicrotask(() => {
          process.emit(options.signal);
          if (options.repeatSignal) process.emit(options.signal === "SIGINT" ? "SIGTERM" : "SIGINT");
        });
      }
      const status = options.failFirst && spawned.length === 1 ? 1 : 0;
      if (!options.stubbornChildren) setImmediate(() => child.finish(status, null));
      return child;
    };
    process.kill = (pid, signal) => {
      const child = children.get(-pid);
      if (!child) throw new Error("Attempted to kill a non-owned process: " + pid);
      killed.push({ pid, signal });
      if (!options.stubbornChildren || signal === "SIGKILL") queueMicrotask(() => child.finish(null, signal));
      return true;
    };
    process.on("exit", () => console.log("FAKE_BATCH_RECEIPT=" + JSON.stringify({
      spawned, runners, killed, active: children.size,
      listeners: [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
    })));
    syncBuiltinESMExports();
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      runnerPath,
      ...args,
    ],
    {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        npm_execpath: fixtureFile(
          "fake-runtime",
          process.platform === "win32" ? "bun.exe" : "bun",
        ),
        AGENT_TEST_CONCURRENCY: "2",
        AGENT_TEST_BATCH_SIZE: String(options.batchSize ?? 1),
        AGENT_TEST_VERBOSE: "0",
      },
    },
  );
  expect(result.error).toBeUndefined();
  const receiptLine = result.stdout
    .split("\n")
    .find((line) => line.startsWith("FAKE_BATCH_RECEIPT="));
  if (!receiptLine) throw new Error(`Runner omitted receipt: ${result.stderr}`);
  const receipt = JSON.parse(
    receiptLine.slice("FAKE_BATCH_RECEIPT=".length),
  ) as {
    spawned: string[][];
    runners: string[];
    killed: { pid: number; signal: string }[];
    active: number;
    listeners: number[];
  };
  return { ...result, receipt };
}

function fixtureFile(...segments: string[]): string {
  const filePath = path.join(fixtureRoot, ...segments);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "fixture");
  return filePath;
}

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("agent Vitest batch orchestration", () => {
  test("runs only explicitly selected eligible files, deduplicated and batched", () => {
    const result = runFakeBatches(
      [
        "src/c.test.ts",
        "./src/a.test.ts",
        path.join(packageRoot, "src/a.test.ts"),
      ],
      { batchSize: 2 },
    );
    expect(result.status).toBe(0);
    expect(result.receipt.spawned).toEqual([
      ["src/a.test.ts", "src/c.test.ts"],
    ]);
    expect(result.receipt.active).toBe(0);
    expect(result.receipt.listeners).toEqual([0, 0]);
  });

  test("accepts a leading argument separator without widening file selection", () => {
    const result = runFakeBatches(["--", "src/b.test.ts"]);
    expect(result.status).toBe(0);
    expect(result.receipt.spawned).toEqual([["src/b.test.ts"]]);
  });

  test("rejects a separator without an explicit file instead of running everything", () => {
    const result = runFakeBatches(["--"]);
    expect(result.status).toBe(1);
    expect(result.receipt.spawned).toEqual([]);
    expect(result.stderr).toContain("eligible test file");
  });

  test.each([
    "--watch",
    "-t",
    "",
    "--",
    "src",
    "src/missing.test.ts",
    "src/*.test.ts",
    "src/excluded.live.test.ts",
    "src/not-a-test.ts",
    "scripts/mobile-workspace-entry.mjs",
    "test/crash-restart-supervisor.test.ts",
    "../ui/src/a.test.ts",
    path.join(path.dirname(packageRoot), "ui/src/a.test.ts"),
  ])(
    "rejects invalid selection %j before spawning even a valid sibling",
    (invalid) => {
      const result = runFakeBatches(["src/a.test.ts", invalid]);
      expect(result.status).toBe(1);
      expect(result.receipt.spawned).toEqual([]);
      expect(result.stderr).toMatch(/unsupported|eligible/i);
    },
  );

  test("retains the full eligible default suite with no selection", () => {
    const result = runFakeBatches([]);
    expect(result.status).toBe(0);
    expect(result.receipt.spawned).toEqual([
      ["src/a.test.ts"],
      ["src/b.test.ts"],
      ["src/c.test.ts"],
      ["scripts/mobile-workspace-entry.test.mjs"],
    ]);
    expect(result.receipt.runners).toEqual([
      "x vitest run",
      "x vitest run",
      "x vitest run",
      "bun test",
    ]);
  });

  test.each(["SIGINT", "SIGTERM"] as const)(
    "%s stops queued spawns and reports interruption",
    (signal) => {
      const result = runFakeBatches([], { signal });
      expect(result.status).toBe(signal === "SIGINT" ? 130 : 143);
      expect(result.receipt.spawned).toEqual([
        ["src/a.test.ts"],
        ["src/b.test.ts"],
      ]);
      expect(result.receipt.killed).toEqual(
        [900000, 900001].map((pid) => ({
          pid: process.platform === "win32" ? pid : -pid,
          signal: "SIGTERM",
        })),
      );
      expect(result.receipt.active).toBe(0);
      expect(result.receipt.listeners).toEqual([0, 0]);
      expect(result.stderr).toContain(`interrupted by ${signal}`);
      expect(result.stdout).not.toContain("passed");
    },
  );

  test.each(["SIGINT", "SIGTERM"] as const)(
    "a second signal terminates stubborn children while preserving the first %s exit code",
    (signal) => {
      const result = runFakeBatches([], {
        signal,
        repeatSignal: true,
        stubbornChildren: true,
      });
      expect(result.status).toBe(signal === "SIGINT" ? 130 : 143);
      expect(result.receipt.spawned).toEqual([
        ["src/a.test.ts"],
        ["src/b.test.ts"],
      ]);
      expect(result.receipt.killed).toEqual(
        ["SIGTERM", "SIGKILL"].flatMap((terminationSignal) =>
          [900000, 900001].map((pid) => ({
            pid: process.platform === "win32" ? pid : -pid,
            signal: terminationSignal,
          })),
        ),
      );
      expect(result.receipt.active).toBe(0);
      expect(result.receipt.listeners).toEqual([0, 0]);
      expect(result.stderr).toContain(`interrupted by ${signal}`);
      expect(result.stdout).not.toContain("passed");
    },
  );

  test("runs a Bun-runtime script test as its own bun test batch beside Vitest batches", () => {
    // batchSize 2 would pair the files if the .mjs test were a Vitest file;
    // it must stay alone under `bun test`, which the orchestrator's evidence
    // guard then sees through the single wrapper command (#31149).
    const result = runFakeBatches(
      ["scripts/mobile-workspace-entry.test.mjs", "src/a.test.ts"],
      { batchSize: 2 },
    );
    expect(result.status).toBe(0);
    expect(result.receipt.spawned).toEqual([
      ["src/a.test.ts"],
      ["scripts/mobile-workspace-entry.test.mjs"],
    ]);
    expect(result.receipt.runners).toEqual(["x vitest run", "bun test"]);
    expect(result.receipt.active).toBe(0);
    expect(result.receipt.listeners).toEqual([0, 0]);
  });

  test("ordinary test failure does not cancel queued siblings", () => {
    const result = runFakeBatches([], { failFirst: true });
    expect(result.status).toBe(1);
    expect(result.receipt.spawned).toEqual([
      ["src/a.test.ts"],
      ["src/b.test.ts"],
      ["src/c.test.ts"],
      ["scripts/mobile-workspace-entry.test.mjs"],
    ]);
    expect(result.receipt.killed).toEqual([]);
    expect(result.receipt.listeners).toEqual([0, 0]);
    expect(result.stderr).toContain("1 batch(es) failed");
  });

  test("requires complete reporter arguments and rejects unsupported overrides", () => {
    for (const args of [
      ["--reporter=junit"],
      ["--outputFile.junit=report.xml"],
      ["--reporter=default"],
      ["--outputFile.junit="],
      ["--passWithNoTests"],
      [
        "--reporter=junit",
        "--outputFile.junit=one.xml",
        "--outputFile.junit=two.xml",
      ],
    ]) {
      expect(() => parseAgentTestArgs(args)).toThrow();
    }
    expect(
      parseAgentTestArgs([
        "--reporter=default",
        "--reporter=junit",
        "--outputFile.junit=report.xml",
      ]).reporterOutfile,
    ).toBe("report.xml");
  });

  test("missing, malformed and forged batch evidence cannot publish an aggregate", () => {
    const fragment = path.join(fixtureRoot, "invalid-fragment.xml");
    const destination = path.join(fixtureRoot, "invalid-aggregate.xml");
    expect(() => mergeAgentJunit([fragment], destination)).toThrow();
    for (const xml of [
      "<testsuites>",
      '<testsuites tests="9"><testsuite tests="1"><testcase name="actual" /></testsuite></testsuites>',
      '<testsuites tests="1" failures="1"><testsuite tests="1" failures="1"><testcase name="failed"><failure>assertion</failure></testcase></testsuite></testsuites>',
    ]) {
      writeFileSync(fragment, xml);
      expect(() => mergeAgentJunit([fragment], destination)).toThrow();
      expect(existsSync(destination)).toBe(false);
    }
    expect(() => mergeAgentJunit([], destination)).toThrow();
  });

  test("classifies only scripts/*.test.mjs as Bun-runtime tests and isolates each one", () => {
    expect(isBunRuntimeTest("scripts/mobile-workspace-entry.test.mjs")).toBe(
      true,
    );
    for (const file of [
      "scripts/mobile-workspace-entry.mjs",
      "scripts/run-vitest-batches.test.ts",
      "src/entry.test.mjs",
      "test/entry.test.mjs",
    ]) {
      expect(isBunRuntimeTest(file)).toBe(false);
    }
    expect(
      createRunnerBatches(
        [
          "scripts/z.test.mjs",
          "src/a.test.ts",
          "src/b.test.ts",
          "src/c.test.ts",
        ],
        2,
      ),
    ).toEqual([
      { runner: "vitest", files: ["src/a.test.ts", "src/b.test.ts"] },
      { runner: "vitest", files: ["src/c.test.ts"] },
      { runner: "bun", files: ["scripts/z.test.mjs"] },
    ]);
  });

  test("builds a shell-free bun test invocation that emits JUnit only when asked", () => {
    expect(
      createBunTestInvocation(
        "C:/Bun/bun.exe",
        ["scripts/mobile-workspace-entry.test.mjs"],
        "C:/tmp/0.xml",
      ),
    ).toEqual({
      command: "C:/Bun/bun.exe",
      args: [
        "test",
        "--reporter=junit",
        "--reporter-outfile=C:/tmp/0.xml",
        "scripts/mobile-workspace-entry.test.mjs",
      ],
    });
    expect(
      createBunTestInvocation("/usr/bin/bun", ["scripts/x.test.mjs"], undefined)
        .args,
    ).toEqual(["test", "scripts/x.test.mjs"]);
  });

  test("merges a Bun fragment, which omits the errors count, with Vitest fragments", () => {
    const bunFragment = path.join(fixtureRoot, "bun-fragment.xml");
    writeFileSync(
      bunFragment,
      `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" assertions="0" failures="0" skipped="0" time="0.2">
  <testsuite name="scripts/mobile-workspace-entry.test.mjs" file="scripts/mobile-workspace-entry.test.mjs" tests="2" assertions="0" failures="0" skipped="0" time="0.1">
    <testcase name="one" classname="" time="0.05" file="scripts/mobile-workspace-entry.test.mjs" line="13" assertions="0" />
    <testcase name="two" classname="" time="0.05" file="scripts/mobile-workspace-entry.test.mjs" line="20" assertions="0" />
  </testsuite>
</testsuites>
`,
    );
    const vitestFragment = path.join(fixtureRoot, "vitest-fragment.xml");
    writeFileSync(
      vitestFragment,
      `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vitest tests" tests="1" failures="0" errors="0" time="0.1">
  <testsuite name="src/a.test.ts" timestamp="2026-09-12T00:00:00.000Z" hostname="ci" tests="1" failures="0" errors="0" skipped="0" time="0.1">
    <testcase classname="src/a.test.ts" name="a" time="0.1" />
  </testsuite>
</testsuites>
`,
    );
    const merged = path.join(fixtureRoot, "merged", "report.xml");
    mergeAgentJunit([vitestFragment, bunFragment], merged);
    const report = readFileSync(merged, "utf8");
    expect(report).toMatch(
      /<testsuites tests="3" failures="0" errors="0" skipped="0">/,
    );
    expect(report).toContain('name="scripts/mobile-workspace-entry.test.mjs"');
    expect(report).toContain('name="src/a.test.ts"');
  });

  test("keeps sorted file membership isolated and complete", () => {
    expect(createBatches(["a.test.ts", "b.test.ts", "c.test.ts"], 1)).toEqual([
      ["a.test.ts"],
      ["b.test.ts"],
      ["c.test.ts"],
    ]);
    expect(createBatches(["a.test.ts", "b.test.ts", "c.test.ts"], 2)).toEqual([
      ["a.test.ts", "b.test.ts"],
      ["c.test.ts"],
    ]);
  });

  test("uses defaults only when unset and rejects malformed values", () => {
    expect(positiveInteger(undefined, "TEST_VALUE", 4)).toBe(4);
    expect(positiveInteger("", "TEST_VALUE", 4)).toBe(4);
    expect(positiveInteger("8", "TEST_VALUE", 4)).toBe(8);
    for (const value of ["0", "-1", "1.5", "abc", "999999999999999999999"]) {
      expect(() => positiveInteger(value, "TEST_VALUE", 4)).toThrow(
        "TEST_VALUE must be a positive integer.",
      );
    }
  });

  test("prefers Bun's validated package-runner executable, including a quoted spaced path", () => {
    const bunExecutable = fixtureFile("Bun Runtime", "bun.exe");
    expect(
      resolveBunExecutable(
        {
          npm_execpath: `"${bunExecutable}"`,
          PATH: "",
        },
        "win32",
      ),
    ).toBe(bunExecutable);
  });

  test("rejects a bunx.cmd package runner and finds bun.exe through PATHEXT", () => {
    const bunxShim = fixtureFile("shim", "bunx.cmd");
    const bunExecutable = fixtureFile("PATH Runtime", "bun.exe");
    expect(
      resolveBunExecutable(
        {
          npm_execpath: bunxShim,
          PATH: `"${path.dirname(bunExecutable)}"`,
          PATHEXT: ".CMD;.EXE",
        },
        "win32",
      ),
    ).toBe(bunExecutable);
  });

  test("resolves the direct Unix Bun executable", () => {
    const bunExecutable = fixtureFile("unix-runtime", "bun");
    expect(
      resolveBunExecutable({ PATH: path.dirname(bunExecutable) }, "linux"),
    ).toBe(bunExecutable);
  });

  test("returns null instead of launching a shell shim when Bun is missing", () => {
    const bunxShim = fixtureFile("only-shim", "bunx.cmd");
    expect(
      resolveBunExecutable(
        {
          npm_execpath: bunxShim,
          PATH: path.dirname(bunxShim),
          PATHEXT: ".CMD;.BAT",
        },
        "win32",
      ),
    ).toBeNull();
  });

  test("builds a shell-free bun x Vitest invocation", () => {
    expect(
      createVitestInvocation("C:/Bun/bun.exe", [
        "src/a.test.ts",
        "src/b.test.ts",
      ]),
    ).toEqual({
      command: "C:/Bun/bun.exe",
      args: [
        "x",
        "vitest",
        "run",
        "--config",
        "vitest.config.ts",
        "src/a.test.ts",
        "src/b.test.ts",
      ],
    });
  });
});
