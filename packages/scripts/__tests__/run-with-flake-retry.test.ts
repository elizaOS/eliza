// Exercises the run-with-flake-retry wrapper against real child processes: single-run passthrough, signature-gated retry, and usage validation.
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

	test("fails usage on a missing separator or invalid regex", () => {
		expect(runWrapper([NODE_BIN, "-e", "0"]).status).toBe(2);
		expect(runWrapper(["(", "--", NODE_BIN, "-e", "0"]).status).toBe(2);
	});
});
