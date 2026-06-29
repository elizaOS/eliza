/**
 * Real-PTY e2e: drives the interactive `eliza-autonomous tui` command under an
 * actual pseudo-terminal (node-pty), so the layer that only exists against a
 * real TTY is exercised end-to-end — `ProcessTerminal` raw mode, the Kitty
 * keyboard-protocol query, `StdinBuffer`, real keystroke → render round-trips,
 * and SIGWINCH resize. The injectable `VirtualTerminal` harness cannot reach any
 * of that; it stubs the terminal.
 *
 * node-pty is an optional dependency (prebuilt native module). When it is not
 * installed/loadable the suite skips rather than failing, so environments
 * without it (or a platform with no prebuild) stay green. The CI server lane
 * installs it, so the lane runs there.
 *
 * Like the child-process smoke, this points the TUI at a dead loopback URL: the
 * shell tolerates a missing backend (refreshViews/Commands catch) and still
 * renders + prints the readiness marker, so no server is needed.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const binPath = join(repoRoot, "packages", "agent", "src", "bin.ts");

// Load node-pty AND prove it can actually allocate a PTY here, else skip.
// node-pty is an optional native dep: it ships no Linux prebuild (CI compiles
// it from source) and on macOS arm64 its prebuilt spawn-helper is unsigned, so
// amfid blocks it unless signed (`codesign -s - …/prebuilds/*/spawn-helper`).
// When a real PTY can't be spawned the suite skips instead of failing red.
type PtyModule = typeof import("node-pty");
async function loadNodePty(): Promise<PtyModule | null> {
  let mod: PtyModule;
  try {
    mod = (await import("node-pty")) as PtyModule;
  } catch {
    return null;
  }
  try {
    const probe = mod.spawn(
      process.platform === "win32" ? "cmd.exe" : "/bin/echo",
      [],
      {
        cols: 2,
        rows: 2,
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
      },
    );
    probe.kill();
  } catch {
    return null; // posix_spawnp failed (no build / unsigned helper / sandbox)
  }
  return mod;
}
const nodePty = await loadNodePty();

interface PtyHandle {
  data: () => string;
  write: (s: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  exit: Promise<number>;
}

function spawnTui(): PtyHandle {
  if (!nodePty) throw new Error("node-pty unavailable");
  const child = nodePty.spawn(
    "bun",
    [
      "--conditions=eliza-source",
      binPath,
      "tui",
      "--api",
      "http://127.0.0.1:1",
    ],
    {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: repoRoot,
      env: { ...process.env, ELIZA_TERMINAL_TUI: "1" },
    },
  );
  let buffer = "";
  child.onData((chunk) => {
    buffer += chunk;
  });
  const exit = new Promise<number>((resolve) => {
    child.onExit(({ exitCode }) => resolve(exitCode));
  });
  return {
    data: () => buffer,
    write: (s) => child.write(s),
    resize: (cols, rows) => child.resize(cols, rows),
    kill: () => child.kill(),
    exit,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 30_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

const describePty = nodePty ? describe : describe.skip;

describePty("real-PTY tui session (node-pty)", () => {
  let session: PtyHandle | null = null;
  afterEach(() => {
    try {
      session?.kill();
    } catch {
      // already exited
    }
    session = null;
  });

  it("renders the shell through a real TTY, echoes a keystroke, resizes, and quits", async () => {
    session = spawnTui();

    // Boot: the readiness marker prints after the shell mounts, and the
    // rendered header reaches the PTY through ProcessTerminal.
    expect(
      await waitFor(() => session?.data().includes("elizaos-tui-ready")),
    ).toBe(true);
    expect(session?.data()).toContain("elizaOS terminal tui");

    // Real keystroke → StdinBuffer → editor → render round-trip: the composer
    // is focused by default, so typed text is echoed in the rendered frame.
    session?.write("ZZZ");
    expect(await waitFor(() => session?.data().includes("ZZZ"))).toBe(true);

    // SIGWINCH resize must not crash the renderer; it keeps rendering.
    const beforeResize = session?.data().length ?? 0;
    session?.resize(100, 30);
    expect(
      await waitFor(() => (session?.data().length ?? 0) > beforeResize),
    ).toBe(true);
    expect(session?.data()).toContain("elizaOS terminal tui");

    // Ctrl+C exits cleanly (drains stdin, restores the terminal).
    session?.write("\x03");
    const code = await Promise.race([
      session?.exit ?? Promise.resolve(-1),
      new Promise<number>((resolve) => setTimeout(() => resolve(-2), 10_000)),
    ]);
    // Exited (0 from clean stop, or the signal code) rather than hanging.
    expect(code).not.toBe(-2);
  }, 90_000);
});
