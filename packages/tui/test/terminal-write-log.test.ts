/**
 * Exercises ProcessTerminal.write's TUI_WRITE_LOG capture over the real fs path
 * — no mocked fs: the log target is a real unwritable path so appendFileSync
 * genuinely throws. Guards #12739's J6 keep: a diagnostic-write failure must
 * surface (to stderr) and disable further attempts, never be silently swallowed.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "vitest";
import { ProcessTerminal } from "../src/terminal.js";

describe("ProcessTerminal TUI_WRITE_LOG failure surfacing (#12739)", () => {
  let savedEnv: string | undefined;
  let stdoutWrite: typeof process.stdout.write;
  let stderrWrite: typeof process.stderr.write;
  let stderrCapture: string;

  beforeEach(() => {
    savedEnv = process.env.TUI_WRITE_LOG;
    // A path whose parent does not exist -> appendFileSync throws ENOENT.
    process.env.TUI_WRITE_LOG = "/nonexistent-dir-12739/does/not/exist.log";

    stdoutWrite = process.stdout.write.bind(process.stdout);
    stderrWrite = process.stderr.write.bind(process.stderr);
    stderrCapture = "";
    // Swallow stdout (the terminal writes ANSI to it) and capture stderr.
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrCapture += String(chunk);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    if (savedEnv === undefined) {
      delete process.env.TUI_WRITE_LOG;
    } else {
      process.env.TUI_WRITE_LOG = savedEnv;
    }
  });

  it("surfaces the log-write failure to stderr and disables further attempts", () => {
    const terminal = new ProcessTerminal();

    // First write triggers the failing appendFileSync; the error must surface.
    terminal.write("hello");
    assert.ok(
      stderrCapture.includes("TUI_WRITE_LOG: failed to write to"),
      `expected the diagnostic failure on stderr, got: ${JSON.stringify(stderrCapture)}`,
    );

    // Log path is now disabled: a second write must NOT re-attempt (no second
    // stderr line), proving the failure is not swallowed-and-retried forever.
    const afterFirst = stderrCapture;
    terminal.write("world");
    assert.strictEqual(
      stderrCapture,
      afterFirst,
      "a disabled write-log must not re-attempt on subsequent writes",
    );
  });
});
