/**
 * Bun native PTY adapter for interactive terminal sessions.
 * It uses `Bun.spawn({ terminal })` under Bun because node-pty's write path is broken there, while preserving the same handle contract the Node adapter uses.
 */

import type { PtyHandle, PtySpawn } from "./pty-types";

export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/** The subset of `Bun.spawn` + `Bun.Terminal` this adapter relies on. */
interface BunLike {
  spawn(
    cmd: string[],
    opts: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      terminal: {
        cols: number;
        rows: number;
        name?: string;
        data: (terminal: unknown, bytes: Uint8Array) => void;
        exit: (terminal: unknown, code: number) => void;
      };
    },
  ): {
    pid: number;
    terminal?: {
      write(data: string): void;
      resize(cols: number, rows: number): void;
    };
    exited?: Promise<number>;
    kill(signal?: number | string): void;
  };
}

/**
 * A {@link PtySpawn} backed by Bun's native truePty — the same mechanism the
 * Electrobun host uses. Conforms to our {@link PtyHandle} so the session store
 * is engine-agnostic.
 */
export const bunTruePtySpawn: PtySpawn = (file, args, opts): PtyHandle => {
  const Bun = (globalThis as unknown as { Bun: BunLike }).Bun;
  const decoder = new TextDecoder();
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();

  // Buffer output that arrives before the store attaches its onData listener,
  // then flush it to the first subscriber — no first-prompt bytes are lost.
  let earlyBuffer = "";
  const emitData = (text: string) => {
    if (text.length === 0) return;
    if (dataListeners.size === 0) {
      earlyBuffer += text;
      return;
    }
    for (const l of dataListeners) l(text);
  };

  let exitFired = false;
  const fireExit = (code: number) => {
    if (exitFired) return;
    exitFired = true;
    for (const l of exitListeners) l({ exitCode: code });
  };

  const proc = Bun.spawn([file, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    terminal: {
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      ...(opts.name ? { name: opts.name } : {}),
      data: (_terminal, bytes) =>
        emitData(decoder.decode(bytes, { stream: true })),
      // The terminal `exit` callback reports the PTY-teardown status (always 1
      // under Bun), NOT the process exit code — so we ignore it here and take
      // the real code from `proc.exited` below.
      exit: () => {},
    },
  });
  // `proc.exited` is the authoritative process exit code.
  void proc.exited?.then((code) => fireExit(code)).catch(() => fireExit(1));

  const terminal = proc.terminal;
  return {
    pid: proc.pid,
    write: (data: string) => terminal?.write(data),
    resize: (cols: number, rows: number) => terminal?.resize(cols, rows),
    kill: (signal?: string) => {
      try {
        proc.kill(signal);
      } catch {
        try {
          proc.kill();
        } catch {
          // process already gone
        }
      }
    },
    onData: (listener) => {
      dataListeners.add(listener);
      if (earlyBuffer.length > 0) {
        const pending = earlyBuffer;
        earlyBuffer = "";
        listener(pending);
      }
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
  };
};
