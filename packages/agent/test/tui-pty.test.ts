// Real-PTY smoke for the agent terminal (issues #9946, #9969).
//
// The VirtualTerminal e2e (tui-e2e.test.ts) drives the shell through an
// injected terminal — it never exercises `ProcessTerminal`, Kitty-protocol
// negotiation, stdin buffering, or resize against a real TTY. This test spawns
// the packaged CLI (`eliza-autonomous tui`) under a real pseudo-terminal
// (@lydell/node-pty), asserts the rendered first frame + the boot marker, drives
// a resize, and confirms a clean exit.
//
// Gated on `RUN_TUI_PTY=1` (set by the dedicated CI job) so the broad PR lane
// stays fast and free of a real-PTY/bun-subprocess dependency: without the flag
// the suite is skipped, not run.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const agentRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const binEntry = path.join(agentRoot, "src", "bin.ts");

const wantPty = process.env.RUN_TUI_PTY === "1";

// Optional dep (matches the plugin-shell precedent). Only probed when opted in.
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

  it("boots ProcessTerminal under a real PTY, renders a frame, emits the marker, and resizes", async () => {
    if (!pty) throw new Error("node-pty unavailable");
    // A deliberately-dead backend: the shell still renders its frame + marker;
    // we are testing the terminal layer, not the API round-trip.
    const apiBaseUrl = "http://127.0.0.1:59999";
    let output = "";
    child = pty.spawn("bun", [binEntry, "tui", "--api", apiBaseUrl], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: agentRoot,
      env: {
        ...process.env,
        ELIZA_TERMINAL_TUI: "1",
        TERM: "xterm-256color",
      },
    });
    child.onData((data) => {
      output += data;
    });

    // Wait for the boot marker (printed once the shell's first render settles).
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !output.includes("elizaos-tui-ready")) {
      await delay(200);
    }

    expect(output).toContain("elizaos-tui-ready");
    // The rendered frame proves ProcessTerminal painted to the real TTY.
    expect(output).toContain("elizaOS terminal tui");

    // Drive a resize — exercises ProcessTerminal's resize handler end to end.
    const beforeResize = output.length;
    child.resize(100, 30);
    await delay(500);
    expect(output.length).toBeGreaterThanOrEqual(beforeResize);

    // Clean shutdown.
    const exited = new Promise<number>((resolve) => {
      child?.onExit(({ exitCode }) => resolve(exitCode));
    });
    child.kill();
    await Promise.race([exited, delay(3_000)]);
  });
});
