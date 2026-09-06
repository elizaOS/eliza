/** Tests the real batch runner with deterministic file discovery and fake child processes, never Vitest batches. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import {
  createBatches,
  createVitestInvocation,
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
      [path.join(root, "scripts"), []],
    ]);
    const readDirectory = fs.readdirSync;
    const stat = fs.statSync;
    fs.readdirSync = (directory, ...rest) => inventory.get(directory) ?? readDirectory(directory, ...rest);
    fs.statSync = (file, ...rest) => inventory.get(path.dirname(file))?.includes(path.basename(file))
      ? { isFile: () => true, isDirectory: () => false }
      : stat(file, ...rest);
    const children = new Map();
    const spawned = [];
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
      spawned.push(childArgs.slice(5).map((file) => file.split(path.sep).join("/")));
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
      spawned, killed, active: children.size,
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

  test("ordinary test failure does not cancel queued siblings", () => {
    const result = runFakeBatches([], { failFirst: true });
    expect(result.status).toBe(1);
    expect(result.receipt.spawned).toEqual([
      ["src/a.test.ts"],
      ["src/b.test.ts"],
      ["src/c.test.ts"],
    ]);
    expect(result.receipt.killed).toEqual([]);
    expect(result.receipt.listeners).toEqual([0, 0]);
    expect(result.stderr).toContain("1 batch(es) failed");
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
