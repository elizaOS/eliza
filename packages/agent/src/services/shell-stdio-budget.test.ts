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

  it("keeps the leading slice of an oversized first chunk", () => {
    const state = createShellStdioState();
    const max = 8;
    expect(appendShellStdio(state, "stdout", Buffer.from("x".repeat(20)), max)).toBe(
      "overflow",
    );
    expect(state.stdout).toBe("xxxxxxxx");
    expect(state.bytes).toBe(max);
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

  it("keeps the leading stderr slice of an oversized chunk", () => {
    const state = createShellStdioState();
    expect(
      appendShellStdio(state, "stderr", Buffer.from("yyyyyyyyyy"), 4),
    ).toBe("overflow");
    expect(state.stderr).toBe("yyyy");
    expect(state.bytes).toBe(4);
  });

  it("fills the cap across several pipe-sized chunks", () => {
    const state = createShellStdioState();
    const max = 8;
    expect(appendShellStdio(state, "stdout", Buffer.from("aaa"), max)).toBe(
      "ok",
    );
    expect(appendShellStdio(state, "stdout", Buffer.from("bbb"), max)).toBe(
      "ok",
    );
    expect(appendShellStdio(state, "stdout", Buffer.from("cccc"), max)).toBe(
      "overflow",
    );
    expect(state.bytes).toBe(max);
    expect(state.stdout).toBe("aaabbbcc");
    expect(MAX_SHELL_STDIO_BYTES).toBe(8_388_608);
  });
});
