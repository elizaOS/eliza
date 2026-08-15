/**
 * Exercises the live-test artifact runner with real child processes, including
 * non-zero completion and a signal-resistant process tree that requires the
 * deadline's forced-termination path.
 */
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_TIMER_DELAY_MS,
  parseArgs,
  parseTimeoutMs,
} from "../run-live-test-with-artifacts.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(
  SCRIPT_DIR,
  "..",
  "run-live-test-with-artifacts.mjs",
);
const NODE_BIN = "node";
const posixTest = process.platform === "win32" ? test.skip : test;

function runWithArtifacts(reportRoot: string, args: string[]) {
  return spawnSync(NODE_BIN, [RUNNER, "--report-root", reportRoot, ...args], {
    encoding: "utf8",
    timeout: 20_000,
  });
}

function onlyRunDirectory(reportRoot: string): string {
  const entries = readdirSync(reportRoot, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory(),
  );
  expect(entries).toHaveLength(1);
  return path.join(reportRoot, entries[0].name);
}

function readReport(runDirectory: string) {
  return JSON.parse(
    readFileSync(path.join(runDirectory, "report.json"), "utf8"),
  );
}

function expectCompleteBundle(runDirectory: string) {
  for (const file of [
    "data.js",
    "index.html",
    "llm-calls.jsonl",
    "report.json",
    "stderr.log",
    "stdout.log",
    "trajectory.jsonl",
  ]) {
    expect(existsSync(path.join(runDirectory, file))).toBe(true);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("parseTimeoutMs", () => {
  test("accepts positive integers through the Node timer ceiling", () => {
    expect(parseTimeoutMs("1")).toBe(1);
    expect(parseTimeoutMs("800")).toBe(800);
    expect(parseTimeoutMs(String(MAX_TIMER_DELAY_MS))).toBe(MAX_TIMER_DELAY_MS);
  });

  test("rejects zero, fractional, signed, scientific, and non-decimal forms", () => {
    for (const value of [
      "0",
      "-5",
      "+1",
      "0.4",
      "1.5",
      "1e3",
      "0x10",
      "20foo",
      "800ms",
      "",
      " ",
      "NaN",
      "Infinity",
      "08",
    ]) {
      expect(() => parseTimeoutMs(value)).toThrow(
        `--timeout-ms must be a positive decimal integer from 1 to ${MAX_TIMER_DELAY_MS}`,
      );
    }
  });

  test("rejects values Node would clamp to one millisecond", () => {
    for (const value of [
      String(MAX_TIMER_DELAY_MS + 1),
      "9007199254740992",
      "9".repeat(400),
    ]) {
      expect(() => parseTimeoutMs(value)).toThrow(
        `--timeout-ms must be a positive decimal integer from 1 to ${MAX_TIMER_DELAY_MS}`,
      );
    }
  });
});

describe("parseArgs", () => {
  test("parses a valid timeout and command", () => {
    const options = parseArgs([
      "--label",
      "ok",
      "--timeout-ms",
      "800",
      "--",
      "node",
      "-e",
      "0",
    ]);
    expect(options.timeoutMs).toBe(800);
    expect(options.command).toEqual(["node", "-e", "0"]);
  });

  test("defaults to no deadline when --timeout-ms is omitted", () => {
    expect(parseArgs(["--", "node", "-e", "0"]).timeoutMs).toBe(0);
  });

  test("rejects an over-ceiling, fractional, scientific, or zero timeout", () => {
    for (const value of ["2147483648", "0.4", "1e3", "0", "-5", "abc"]) {
      expect(() =>
        parseArgs(["--timeout-ms", value, "--", "node", "-e", "0"]),
      ).toThrow(
        `--timeout-ms must be a positive decimal integer from 1 to ${MAX_TIMER_DELAY_MS}`,
      );
    }
  });
});

describe("run-live-test-with-artifacts timeout CLI boundary", () => {
  const cases = ["2147483648", "0.4", "1e3", "0", "-5", "abc"];
  for (const value of cases) {
    test(`rejects --timeout-ms ${value} before creating a run bundle`, () => {
      const reportRoot = mkdtempSync(path.join(tmpdir(), "live-artifacts-"));
      try {
        const result = runWithArtifacts(reportRoot, [
          "--label",
          "bad-timeout",
          "--timeout-ms",
          value,
          "--",
          NODE_BIN,
          "-e",
          "process.exit(0)",
        ]);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(
          `--timeout-ms must be a positive decimal integer from 1 to ${MAX_TIMER_DELAY_MS}`,
        );
        // No run directory is created when argument parsing fails closed.
        expect(
          readdirSync(reportRoot, { withFileTypes: true }).filter((entry) =>
            entry.isDirectory(),
          ),
        ).toHaveLength(0);
      } finally {
        rmSync(reportRoot, { recursive: true, force: true });
      }
    });
  }

  test("accepts a valid --timeout-ms and completes the run", () => {
    const reportRoot = mkdtempSync(path.join(tmpdir(), "live-artifacts-"));
    try {
      const result = runWithArtifacts(reportRoot, [
        "--label",
        "valid-timeout",
        "--timeout-ms",
        "800",
        "--",
        NODE_BIN,
        "-e",
        'process.stdout.write("done");',
      ]);
      expect(result.status).toBe(0);
      const runDirectory = onlyRunDirectory(reportRoot);
      const report = readReport(runDirectory);
      expect(report.timeoutMs).toBe(800);
      expect(report.timedOut).toBe(false);
      expect(report.exitCode).toBe(0);
    } finally {
      rmSync(reportRoot, { recursive: true, force: true });
    }
  });
});

describe("run-live-test-with-artifacts", () => {
  test("preserves a completed child's exit and fully drained output", () => {
    const reportRoot = mkdtempSync(path.join(tmpdir(), "live-artifacts-"));
    try {
      const result = runWithArtifacts(reportRoot, [
        "--label",
        "normal-exit",
        "--",
        NODE_BIN,
        "-e",
        'process.stdout.write("stdout-tail"); process.stderr.write("stderr-tail"); process.exitCode = 7;',
      ]);
      expect(result.status).toBe(7);
      const runDirectory = onlyRunDirectory(reportRoot);
      const report = readReport(runDirectory);
      expect(report.exitCode).toBe(7);
      expect(report.timedOut).toBe(false);
      expect(report.stdout).toBe("stdout-tail");
      expect(report.stderr).toBe("stderr-tail");
      expect(report.processEvents.at(-1)).toMatchObject({
        type: "exit",
        code: 7,
      });
      expectCompleteBundle(runDirectory);
    } finally {
      rmSync(reportRoot, { recursive: true, force: true });
    }
  });

  test("records a command-start failure and still finalizes the bundle", () => {
    const reportRoot = mkdtempSync(path.join(tmpdir(), "live-artifacts-"));
    try {
      const result = runWithArtifacts(reportRoot, [
        "--label",
        "spawn-error",
        "--",
        "definitely-not-a-real-binary-live-artifacts",
      ]);
      expect(result.status).toBe(1);
      const runDirectory = onlyRunDirectory(reportRoot);
      const report = readReport(runDirectory);
      expect(report.exitCode).toBe(1);
      expect(report.timedOut).toBe(false);
      expect(
        report.processEvents.map((event: { type: string }) => event.type),
      ).toEqual(["start", "error", "exit"]);
      expect(report.processEvents[1].error).toContain(
        "definitely-not-a-real-binary-live-artifacts",
      );
      expectCompleteBundle(runDirectory);
    } finally {
      rmSync(reportRoot, { recursive: true, force: true });
    }
  });

  posixTest(
    "returns 124 after graceful deadline termination without waiting for escalation",
    () => {
      const reportRoot = mkdtempSync(path.join(tmpdir(), "live-artifacts-"));
      try {
        const startedAt = Date.now();
        const result = runWithArtifacts(reportRoot, [
          "--label",
          "graceful-timeout",
          "--timeout-ms",
          "100",
          "--",
          NODE_BIN,
          "-e",
          "setInterval(() => {}, 1000);",
        ]);
        expect(result.status).toBe(124);
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        const runDirectory = onlyRunDirectory(reportRoot);
        const report = readReport(runDirectory);
        expect(
          report.processEvents.map((event: { type: string }) => event.type),
        ).toEqual(["start", "timeout", "exit"]);
        expect(report.processEvents.at(-1)).toMatchObject({
          type: "exit",
          code: 124,
          signal: "SIGTERM",
        });
        expectCompleteBundle(runDirectory);
      } finally {
        rmSync(reportRoot, { recursive: true, force: true });
      }
    },
  );

  posixTest(
    "forwards a parent interrupt to the timed process tree and finalizes artifacts",
    async () => {
      const reportRoot = mkdtempSync(path.join(tmpdir(), "live-artifacts-"));
      try {
        const runner = spawn(
          NODE_BIN,
          [
            RUNNER,
            "--report-root",
            reportRoot,
            "--label",
            "parent-interrupt",
            "--timeout-ms",
            "30000",
            "--",
            NODE_BIN,
            "-e",
            'process.stdout.write("READY\\n"); setInterval(() => {}, 1000);',
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let interrupted = false;
        const result = await new Promise<{
          code: number | null;
          signal: string | null;
        }>((resolve, reject) => {
          const failsafe = setTimeout(() => {
            runner.kill("SIGKILL");
            reject(new Error("runner did not stop after SIGINT"));
          }, 10_000);
          runner.once("error", (error) => {
            clearTimeout(failsafe);
            reject(error);
          });
          runner.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
            if (!interrupted && stdout.includes("READY")) {
              interrupted = true;
              runner.kill("SIGINT");
            }
          });
          runner.once("close", (code, signal) => {
            clearTimeout(failsafe);
            resolve({ code, signal });
          });
        });
        expect(result).toEqual({ code: 1, signal: null });
        const runDirectory = onlyRunDirectory(reportRoot);
        const report = readReport(runDirectory);
        expect(report.timedOut).toBe(false);
        expect(
          report.processEvents.map((event: { type: string }) => event.type),
        ).toEqual(["start", "stdout", "parent_signal", "exit"]);
        expect(report.processEvents.at(-1)).toMatchObject({
          type: "exit",
          code: 1,
          signal: "SIGINT",
        });
        expectCompleteBundle(runDirectory);
      } finally {
        rmSync(reportRoot, { recursive: true, force: true });
      }
    },
    15_000,
  );

  posixTest(
    "returns 124, finalizes artifacts, and leaves no signal-resistant descendant",
    () => {
      const reportRoot = mkdtempSync(path.join(tmpdir(), "live-artifacts-"));
      try {
        const childScript = `
          const { spawn } = require("node:child_process");
          process.on("SIGTERM", () => {});
          const grandchild = spawn(process.execPath, [
            "-e",
            "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
          ], { stdio: "ignore" });
          process.stdout.write("GRANDCHILD_PID=" + grandchild.pid + "\\n");
          setInterval(() => {}, 1000);
        `;
        const startedAt = Date.now();
        const result = runWithArtifacts(reportRoot, [
          "--label",
          "resistant-tree",
          "--timeout-ms",
          "100",
          "--",
          NODE_BIN,
          "-e",
          childScript,
        ]);
        expect(result.status).toBe(124);
        expect(Date.now() - startedAt).toBeLessThan(10_000);

        const runDirectory = onlyRunDirectory(reportRoot);
        const report = readReport(runDirectory);
        expect(report.exitCode).toBe(124);
        expect(report.timedOut).toBe(true);
        expect(
          report.processEvents.map((event: { type: string }) => event.type),
        ).toEqual(["start", "stdout", "timeout", "timeout_escalation", "exit"]);
        const pidMatch = report.stdout.match(/GRANDCHILD_PID=(\d+)/);
        expect(pidMatch).not.toBeNull();
        expect(processIsAlive(Number(pidMatch?.[1]))).toBe(false);
        expectCompleteBundle(runDirectory);
      } finally {
        rmSync(reportRoot, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
