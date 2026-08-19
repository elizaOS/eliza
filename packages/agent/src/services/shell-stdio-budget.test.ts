/**
 * Isolated overflow tests for the host-shell stdio budget. Deterministic —
 * no child process, sandbox, or PATH authority.
 */
import { describe, expect, it } from "vitest";
import {
  appendShellStdio,
  createShellStdioState,
  MAX_SHELL_STDIO_BYTES,
} from "./shell-stdio-budget.ts";

describe("appendShellStdio", () => {
  it("accepts a last-fit honest chunk", () => {
    const state = createShellStdioState();
    expect(appendShellStdio(state, "stdout", Buffer.from("ok"), 4)).toBe("ok");
    expect(state.stdout).toBe("ok");
    expect(state.bytes).toBe(2);
  });

  it("rejects a single chunk larger than the budget without retaining it", () => {
    const state = createShellStdioState();
    const chunk = Buffer.alloc(MAX_SHELL_STDIO_BYTES + 1, 0x78);
    expect(appendShellStdio(state, "stdout", chunk)).toBe("overflow");
    expect(state.stdout).toBe("");
    expect(state.bytes).toBe(0);
  });

  it("rejects the write that would cross the budget after honest output", () => {
    const state = createShellStdioState();
    expect(appendShellStdio(state, "stdout", Buffer.from("abcd"), 8)).toBe(
      "ok",
    );
    expect(appendShellStdio(state, "stderr", Buffer.from("efgh"), 8)).toBe(
      "ok",
    );
    expect(appendShellStdio(state, "stdout", Buffer.from("x"), 8)).toBe(
      "overflow",
    );
    expect(state.stdout).toBe("abcd");
    expect(state.stderr).toBe("efgh");
    expect(state.bytes).toBe(8);
  });
});
