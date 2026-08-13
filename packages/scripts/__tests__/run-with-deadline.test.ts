/**
 * Exercises the run-with-deadline wrapper against real child processes: exit-
 * code passthrough, deadline group kill, usage validation, and Node timer
 * ceiling rejection before spawn.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_TIMER_DELAY_MS,
  parseArgs,
  parseDeadlineMs,
} from "../run-with-deadline.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.resolve(SCRIPT_DIR, "..", "run-with-deadline.mjs");
const NODE_BIN = process.execPath;

function runWrapper(args: string[], timeoutMs = 30_000) {
  return spawnSync(NODE_BIN, [WRAPPER, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

describe("parseDeadlineMs", () => {
  test("accepts positive integers through the Node timer ceiling", () => {
    expect(parseDeadlineMs("1")).toBe(1);
    expect(parseDeadlineMs("00001")).toBe(1);
    expect(parseDeadlineMs("500")).toBe(500);
    expect(parseDeadlineMs("00500")).toBe(500);
    expect(parseDeadlineMs(String(MAX_TIMER_DELAY_MS))).toBe(
      MAX_TIMER_DELAY_MS,
    );
  });

  test("rejects zero, fractional, signed, partial, and non-decimal forms", () => {
    for (const value of [
      "0",
      "-1",
      "+1",
      "1.5",
      "1e3",
      "0x10",
      "500ms",
      "500junk",
      "",
      " ",
      "NaN",
      "Infinity",
    ]) {
      expect(() => parseDeadlineMs(value)).toThrow(
        `deadline-ms must be a positive decimal integer from 1 to ${MAX_TIMER_DELAY_MS}`,
      );
    }
  });

  test("rejects values Node would clamp to one millisecond", () => {
    for (const value of [
      String(MAX_TIMER_DELAY_MS + 1),
      "9007199254740992",
      "9".repeat(400),
    ]) {
      expect(() => parseDeadlineMs(value)).toThrow(
        `deadline-ms must be a positive decimal integer from 1 to ${MAX_TIMER_DELAY_MS}`,
      );
    }
  });
});

describe("parseArgs", () => {
  test("returns deadline and command for valid argv", () => {
    expect(parseArgs(["1200", "--", "node", "-e", "0"])).toEqual({
      deadlineMs: 1200,
      command: "node",
      args: ["-e", "0"],
    });
  });

  test("rejects missing separator or command", () => {
    expect(() => parseArgs(["1000", "node", "-e", "0"])).toThrow(/usage:/);
    expect(() => parseArgs(["1000", "--"])).toThrow(/usage:/);
    expect(() => parseArgs(["--", "node", "-e", "0"])).toThrow(/usage:/);
    expect(() => parseArgs(["", "--", "node", "-e", "0"])).toThrow(
      /deadline-ms must be a positive decimal integer/,
    );
  });
});

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

  test("preserves padded deadlines and exit behavior through a symlink", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "deadline-link-"));
    const linkedWrapper = path.join(directory, "with-deadline.mjs");
    try {
      symlinkSync(WRAPPER, linkedWrapper);
      const valid = spawnSync(
        NODE_BIN,
        [linkedWrapper, "00030000", "--", NODE_BIN, "-e", "process.exit(7)"],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(valid.status).toBe(7);

      const overflow = spawnSync(
        NODE_BIN,
        [
          linkedWrapper,
          String(MAX_TIMER_DELAY_MS + 1),
          "--",
          NODE_BIN,
          "-e",
          "console.log('should-not-run')",
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(overflow.status).toBe(2);
      expect(overflow.stderr).toContain("deadline-ms");
      expect(overflow.stdout).not.toContain("should-not-run");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  test("rejects an overflowing deadline before spawning the child", () => {
    const result = runWrapper([
      String(MAX_TIMER_DELAY_MS + 1),
      "--",
      NODE_BIN,
      "-e",
      "console.log('should-not-run')",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `deadline-ms must be a positive decimal integer from 1 to ${MAX_TIMER_DELAY_MS}`,
    );
    expect(result.stderr).not.toContain("TimeoutOverflowWarning");
    expect(result.stdout).not.toContain("should-not-run");
  });

  test("accepts the exact Node timer ceiling without overflow warnings", () => {
    const result = runWrapper([
      String(MAX_TIMER_DELAY_MS),
      "--",
      NODE_BIN,
      "-e",
      "process.exit(0)",
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("TimeoutOverflowWarning");
  });
});
