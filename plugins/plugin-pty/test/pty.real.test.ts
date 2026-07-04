/**
 * Real PTY engine tests for the session store and console bridge.
 * They spawn actual OS processes through the runtime-selected PTY backend and assert output, exit, and keystroke flow without the fake handle.
 */

import { describe, expect, it } from "vitest";
import { isBunRuntime } from "../services/bun-pty-spawn";
import type {
  SessionExitEvent,
  SessionOutputEvent,
} from "../services/pty-contract";
import {
  defaultSpawnResolver,
  PtyConsoleBridge,
  PtySessionStore,
} from "../services/pty-session-store";

let ptyAvailable = isBunRuntime();
try {
  if (!ptyAvailable) {
    await import("@lydell/node-pty");
    ptyAvailable = true;
  }
} catch {
  ptyAvailable = false;
}

const suite = ptyAvailable ? describe : describe.skip;
const isWin = process.platform === "win32";
const engine = isBunRuntime() ? "bunTruePty" : "@lydell/node-pty";

suite(`real PTY end-to-end (${engine})`, () => {
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
