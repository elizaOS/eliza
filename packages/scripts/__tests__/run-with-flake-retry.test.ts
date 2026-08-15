/**
 * Exercises the flake-retry wrapper against real child processes, including
 * signatures split across stream chunks and signatures followed by noisy
 * teardown output larger than the retained matching overlap.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.resolve(SCRIPT_DIR, "..", "run-with-flake-retry.mjs");
const NODE_BIN = process.execPath;

function runWrapper(args: string[], timeoutMs = 30_000) {
  return spawnSync(NODE_BIN, [WRAPPER, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

// Child that appends one byte to a counter file per run, then fails with the
// given output on the first run and succeeds on the second — the flake shape.
function flakyChild(counterFile: string, failureLine: string): string {
  return `
		const fs = require("node:fs");
		fs.appendFileSync(${JSON.stringify(counterFile)}, "x");
		if (fs.readFileSync(${JSON.stringify(counterFile)}, "utf8").length === 1) {
			console.error(${JSON.stringify(failureLine)});
			process.exit(1);
		}
		process.exit(0);
	`;
}

function noisyFlakyChild(counterFile: string, failureLine: string): string {
  return `
		const fs = require("node:fs");
		fs.appendFileSync(${JSON.stringify(counterFile)}, "x");
		if (fs.readFileSync(${JSON.stringify(counterFile)}, "utf8").length === 1) {
			process.stdout.write(${JSON.stringify(`${failureLine}\n`)} + "x".repeat(300000));
			process.exit(1);
		}
		process.exit(0);
	`;
}

function splitSignatureFlakyChild(counterFile: string): string {
  return `
		const fs = require("node:fs");
		fs.appendFileSync(${JSON.stringify(counterFile)}, "x");
		if (fs.readFileSync(${JSON.stringify(counterFile)}, "utf8").length === 1) {
			process.stdout.write("error: Failed");
			setTimeout(() => {
				process.stdout.write(" to connect");
				process.exit(1);
			}, 20);
		} else {
			process.exit(0);
		}
	`;
}

function crossStreamNearMatchChild(counterFile: string): string {
  return `
		const fs = require("node:fs");
		fs.appendFileSync(${JSON.stringify(counterFile)}, "x");
		process.stdout.write("error: Failed");
		process.stderr.write(" to connect");
		process.exit(1);
	`;
}

describe("run-with-flake-retry", () => {
  test("passes through success without retrying", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flake-retry-"));
    const counter = path.join(dir, "runs");
    const result = runWrapper([
      "epoll_ctl",
      "--",
      NODE_BIN,
      "-e",
      `require("node:fs").appendFileSync(${JSON.stringify(counter)}, "x"); process.exit(0)`,
    ]);
    expect(result.status).toBe(0);
    expect(readFileSync(counter, "utf8")).toBe("x");
    rmSync(dir, { recursive: true, force: true });
  });

  test("does not retry a failure that misses the signature", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flake-retry-"));
    const counter = path.join(dir, "runs");
    const result = runWrapper([
      "EEXIST[^\\n]*epoll_ctl",
      "--",
      NODE_BIN,
      "-e",
      flakyChild(counter, "1 tests failed: expected 2 to be 3"),
    ]);
    expect(result.status).toBe(1);
    expect(readFileSync(counter, "utf8")).toBe("x");
    rmSync(dir, { recursive: true, force: true });
  });

  test("retries once when the failure output matches the signature", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flake-retry-"));
    const counter = path.join(dir, "runs");
    const result = runWrapper([
      "EEXIST[^\\n]*epoll_ctl|error: Failed to connect",
      "--",
      NODE_BIN,
      "-e",
      flakyChild(counter, "error: EEXIST: file already exists, epoll_ctl"),
    ]);
    expect(result.status).toBe(0);
    expect(readFileSync(counter, "utf8")).toBe("xx");
    expect(result.stderr).toContain("matched flake signature");
    rmSync(dir, { recursive: true, force: true });
  });

  test("retains a match followed by more output than the bounded overlap", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flake-retry-"));
    const counter = path.join(dir, "runs");
    const result = runWrapper([
      "EEXIST[^\\n]*epoll_ctl",
      "--",
      NODE_BIN,
      "-e",
      noisyFlakyChild(counter, "error: EEXIST: file already exists, epoll_ctl"),
    ]);
    expect(result.status).toBe(0);
    expect(readFileSync(counter, "utf8")).toBe("xx");
    expect(result.stderr).toContain("matched flake signature");
    rmSync(dir, { recursive: true, force: true });
  });

  test("matches a signature split across output chunks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flake-retry-"));
    const counter = path.join(dir, "runs");
    const result = runWrapper([
      "error: Failed to connect",
      "--",
      NODE_BIN,
      "-e",
      splitSignatureFlakyChild(counter),
    ]);
    expect(result.status).toBe(0);
    expect(readFileSync(counter, "utf8")).toBe("xx");
    expect(result.stderr).toContain("matched flake signature");
    rmSync(dir, { recursive: true, force: true });
  });

  test("does not fabricate a match across stdout and stderr", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flake-retry-"));
    const counter = path.join(dir, "runs");
    const result = runWrapper([
      "error: Failed to connect",
      "--",
      NODE_BIN,
      "-e",
      crossStreamNearMatchChild(counter),
    ]);
    expect(result.status).toBe(1);
    expect(readFileSync(counter, "utf8")).toBe("x");
    expect(result.stderr).not.toContain("matched flake signature");
    rmSync(dir, { recursive: true, force: true });
  });

  test("fails usage on a missing separator or invalid regex", () => {
    expect(runWrapper([NODE_BIN, "-e", "0"]).status).toBe(2);
    expect(runWrapper(["(", "--", NODE_BIN, "-e", "0"]).status).toBe(2);
  });
});
