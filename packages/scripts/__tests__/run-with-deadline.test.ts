// Exercises the run-with-deadline wrapper against real child processes: exit-code passthrough, deadline group kill, and usage validation.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.resolve(SCRIPT_DIR, "..", "run-with-deadline.mjs");
const NODE_BIN = process.execPath;

function runWrapper(args: string[], timeoutMs = 30_000) {
  return spawnSync(NODE_BIN, [WRAPPER, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

describe("run-with-deadline", () => {
  test("passes through the child's exit code when it finishes in time", () => {
    const result = runWrapper([
      "30000",
      "--",
      NODE_BIN,
      "-e",
      "process.exit(7)",
    ]);
    expect(result.status).toBe(7);
  });

  test("kills a wedged child at the deadline and exits 124", () => {
    const startedAt = Date.now();
    // The child never exits on its own: an armed interval keeps its event
    // loop alive forever, which is exactly the leaked-handle wedge shape.
    const result = runWrapper([
      "500",
      "--",
      NODE_BIN,
      "-e",
      "setInterval(() => {}, 1000);",
    ]);
    expect(result.status).toBe(124);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(result.stderr).toContain("wall-clock deadline of 500ms exceeded");
  });

  test("fails usage when the separator or deadline is missing", () => {
    expect(runWrapper(["--", NODE_BIN, "-e", "0"]).status).toBe(2);
    expect(runWrapper(["not-a-number", "--", NODE_BIN, "-e", "0"]).status).toBe(
      2,
    );
    expect(runWrapper(["1000", NODE_BIN, "-e", "0"]).status).toBe(2);
  });

  test("exits 127 when the command cannot start", () => {
    const result = runWrapper([
      "5000",
      "--",
      "definitely-not-a-real-binary-xyz",
    ]);
    expect(result.status).toBe(127);
  });
});
