import { describe, expect, it } from "vitest";
import type {
  SessionExitEvent,
  SessionOutputEvent,
} from "../services/pty-contract";
import {
  defaultSpawnResolver,
  PtyConsoleBridge,
  PtySessionStore,
} from "../services/pty-session-store";

/**
 * Real end-to-end test of the PTY engine: spawns an ACTUAL OS process through
 * the real store + bridge (no fakes) and asserts output/exit/keystroke flow.
 * Gated on `@lydell/node-pty` actually loading (an optional native module), the
 * same way plugin-shell gates its live PTY tests — skips cleanly where the
 * native build is absent, runs for real where it is present.
 */
let ptyAvailable = false;
try {
  await import("@lydell/node-pty");
  ptyAvailable = true;
} catch {
  ptyAvailable = false;
}

const suite = ptyAvailable ? describe : describe.skip;
const isWin = process.platform === "win32";

suite("real PTY end-to-end (@lydell/node-pty)", () => {
  it("streams a real process's output through the bridge, then exits 0", async () => {
    const bridge = new PtyConsoleBridge();
    const store = new PtySessionStore(bridge, defaultSpawnResolver);
    let out = "";
    bridge.on("session_output", (e) => {
      out += (e as SessionOutputEvent).data;
    });
    const exited = new Promise<number | null>((resolve) => {
      bridge.on("session_exit", (e) =>
        resolve((e as SessionExitEvent).exitCode),
      );
    });

    const info = await store.start({
      command: isWin ? "cmd" : "sh",
      args: isWin ? ["/c", "echo PTYHELLO"] : ["-c", "printf PTYHELLO"],
      cwd: process.cwd(),
      kind: "test",
    });

    const code = await exited;
    expect(out).toContain("PTYHELLO");
    expect(code).toBe(0);
    await store.stop(info.sessionId);
  }, 20_000);

  it("round-trips a real keystroke through the bridge to the process", async () => {
    if (isWin) return; // `cat` echo semantics are POSIX-specific
    const bridge = new PtyConsoleBridge();
    const store = new PtySessionStore(bridge, defaultSpawnResolver);
    let out = "";
    bridge.on("session_output", (e) => {
      out += (e as SessionOutputEvent).data;
    });

    const info = await store.start({
      command: "cat",
      args: [],
      cwd: process.cwd(),
      kind: "test",
    });
    // A PTY echoes input; `cat` also re-emits the line — either way we see it.
    bridge.writeRaw(info.sessionId, "roundtrip\r");
    await new Promise((r) => setTimeout(r, 600));
    expect(out).toContain("roundtrip");
    await store.stop(info.sessionId);
  }, 20_000);
});
