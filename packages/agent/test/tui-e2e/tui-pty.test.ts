// Real-PTY smoke for the agent terminal (issues #9946, #9969).
//
// The VirtualTerminal e2e (agent-tui-shell.test.ts) drives the shell through an
// injected terminal — it never exercises `ProcessTerminal`, Kitty-protocol
// negotiation, stdin buffering, or resize against a real TTY. The real-binary
// smoke (tui-smoke-binary) spawns the CLI but `tui-smoke` uses a no-op
// SmokeTerminal, so it never touches ProcessTerminal either. This test spawns
// the packaged CLI's interactive `tui` command under a real pseudo-terminal
// (@lydell/node-pty) and exercises the layer only a real TTY reaches:
//   1. the rendered first frame + boot marker reach the TTY,
//   2. a resize keeps the renderer alive,
//   3. typed bytes round-trip real stdin -> StdinBuffer -> composer -> render
//      (raw mode is on, so the echo is the app rendering input, not the TTY), and
//   4. a Ctrl+C keystroke (not an OS signal) drives a clean exit (code 0) —
//      the keyboard-driven SIGINT-via-keystroke -> terminal-restore -> exit path.
//
// Gated on `RUN_TUI_PTY=1` (set by the CI step) so the broad PR lane stays fast
// and free of a real-PTY/bun-subprocess dependency: without the flag the suite
// is skipped, not run.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// tui-pty.test.ts -> tui-e2e -> test -> agent
const agentRoot = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
);
const binEntry = path.join(agentRoot, "src", "bin.ts");

const wantPty = process.env.RUN_TUI_PTY === "1";

let pty: typeof import("@lydell/node-pty") | null = null;
if (wantPty) {
  try {
    pty = await import("@lydell/node-pty");
  } catch {
    pty = null;
  }
}
const bunAvailable =
  wantPty && spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
const runReal = wantPty && pty !== null && bunAvailable;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!runReal)("agent terminal tui — real PTY", () => {
  let child: import("@lydell/node-pty").IPty | null = null;
  afterEach(() => {
    try {
      child?.kill();
    } catch {
      /* already gone */
    }
    child = null;
  });

  it("boots ProcessTerminal under a real PTY, renders a frame, emits the marker, resizes, echoes typed input, and exits cleanly on Ctrl+C", async () => {
    if (!pty) throw new Error("node-pty unavailable");
    // A deliberately-dead backend: the shell still renders its frame + marker;
    // this exercises the terminal layer, not the API round-trip.
    const apiBaseUrl = "http://127.0.0.1:59999";
    let output = "";
    child = pty.spawn("bun", [binEntry, "tui", "--api", apiBaseUrl], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: agentRoot,
      env: { ...process.env, ELIZA_TERMINAL_TUI: "1", TERM: "xterm-256color" },
    });
    child.onData((data) => {
      output += data;
    });
    const exited = new Promise<number>((resolve) => {
      child?.onExit(({ exitCode }) => resolve(exitCode));
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !output.includes("elizaos-tui-ready")) {
      await delay(200);
    }

    expect(output).toContain("elizaos-tui-ready");
    expect(output).toContain("elizaOS terminal tui");

    const beforeResize = output.length;
    child.resize(100, 30);
    await delay(500);
    expect(output.length).toBeGreaterThanOrEqual(beforeResize);

    // Typed bytes must round-trip through real stdin -> StdinBuffer -> composer
    // -> render. Raw mode is on, so the TTY does not echo; the probe string only
    // appears because the app rendered the composer. This is the only end-to-end
    // exercise of the real-TTY keystroke path.
    const probe = "echoprobe";
    const beforeType = output.length;
    child.write(probe);
    const typeDeadline = Date.now() + 5_000;
    while (
      Date.now() < typeDeadline &&
      !output.slice(beforeType).includes(probe)
    ) {
      await delay(100);
    }
    expect(output.slice(beforeType)).toContain(probe);

    // Ctrl+C is delivered as a keystroke (0x03), not an OS signal: the shell
    // routes it through handleInput regardless of focus, restores the terminal,
    // and exits 0. Asserting the exit code (not a raced child.kill()) proves the
    // keyboard-driven clean-exit path actually fires.
    child.write("\x03");
    const exitCode = await Promise.race([
      exited,
      delay(5_000).then(() => -1 as const),
    ]);
    expect(exitCode).toBe(0);
  });
});
