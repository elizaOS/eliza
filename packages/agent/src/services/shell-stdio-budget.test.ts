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
    expect(appendShellStdio(state, "stdout", "ok", 4)).toBe("ok");
    expect(state.stdout).toBe("ok");
    expect(state.bytes).toBe(2);
  });

  it("keeps the leading slice of an oversized first chunk", () => {
    const state = createShellStdioState();
    const max = 8;
    expect(appendShellStdio(state, "stdout", "x".repeat(20), max)).toBe(
      "overflow",
    );
    expect(state.stdout).toBe("xxxxxxxx");
    expect(state.bytes).toBe(max);
  });

  it("rejects the write that would cross the budget after honest output", () => {
    const state = createShellStdioState();
    expect(appendShellStdio(state, "stdout", "abcd", 8)).toBe("ok");
    expect(appendShellStdio(state, "stderr", "efgh", 8)).toBe("ok");
    expect(appendShellStdio(state, "stdout", "x", 8)).toBe("overflow");
    expect(state.stdout).toBe("abcd");
    expect(state.stderr).toBe("efgh");
    expect(state.bytes).toBe(8);
  });

  it("keeps the leading stderr slice of an oversized chunk", () => {
    const state = createShellStdioState();
    expect(appendShellStdio(state, "stderr", "yyyyyyyyyy", 4)).toBe("overflow");
    expect(state.stderr).toBe("yyyy");
    expect(state.bytes).toBe(4);
  });

  it("fills the cap across several pipe-sized chunks", () => {
    const state = createShellStdioState();
    const max = 8;
    expect(appendShellStdio(state, "stdout", "aaa", max)).toBe("ok");
    expect(appendShellStdio(state, "stdout", "bbb", max)).toBe("ok");
    expect(appendShellStdio(state, "stdout", "cccc", max)).toBe("overflow");
    expect(state.bytes).toBe(max);
    expect(state.stdout).toBe("aaabbbcc");
    expect(MAX_SHELL_STDIO_BYTES).toBe(8_388_608);
  });

  it("budgets by UTF-8 byte length, not string length", () => {
    const state = createShellStdioState();
    expect(appendShellStdio(state, "stdout", "好好好", 6)).toBe("overflow");
    expect(state.stdout).toBe("好好");
    expect(state.bytes).toBe(6);
  });

  it("does not split a code point to fill the remaining byte budget", () => {
    const state = createShellStdioState();
    expect(appendShellStdio(state, "stdout", "a", 3)).toBe("ok");
    expect(appendShellStdio(state, "stdout", "好", 3)).toBe("overflow");
    expect(state.stdout).toBe("a");
    expect(state.stdout).not.toContain("\uFFFD");
    expect(state.bytes).toBe(1);
    expect(Buffer.byteLength(state.stdout, "utf8")).toBe(state.bytes);
  });

  it("keeps all complete code points before a partial boundary", () => {
    const state = createShellStdioState();
    expect(appendShellStdio(state, "stderr", "好好", 4)).toBe("overflow");
    expect(state.stderr).toBe("好");
    expect(state.bytes).toBe(3);
    expect(Buffer.byteLength(state.stderr, "utf8")).toBe(state.bytes);
  });
});
