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
