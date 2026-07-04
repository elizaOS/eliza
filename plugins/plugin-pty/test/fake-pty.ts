/**
 * Controllable in-memory PTY test double for the PTY session store.
 * Tests exercise the same handle callbacks and write/resize/kill methods as a native PTY while replacing only the operating-system terminal.
 */

import type { PtyHandle, PtySpawn } from "../services/pty-types";

export class FakePty implements PtyHandle {
  readonly pid: number;
  readonly written: string[] = [];
  readonly resized: Array<[number, number]> = [];
  killed = false;
  killedSignal: string | undefined;
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<
    (event: { exitCode: number; signal?: number }) => void
  > = [];

  constructor(pid = 4242) {
    this.pid = pid;
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killedSignal = signal;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(listener);
    return { dispose: () => void 0 };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  } {
    this.exitListeners.push(listener);
    return { dispose: () => void 0 };
  }

  // --- test drivers ---
  emitData(data: string): void {
    for (const l of this.dataListeners) l(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const l of this.exitListeners) l({ exitCode, signal });
  }
}

export interface SpawnCall {
  file: string;
  args: string[];
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    name?: string;
    cols?: number;
    rows?: number;
  };
}

/** A fake `PtySpawn` plus a resolver and the record of what it was called with. */
export function makeFakeSpawn(): {
  spawn: PtySpawn;
  resolver: () => Promise<PtySpawn>;
  calls: SpawnCall[];
  ptys: FakePty[];
} {
  const calls: SpawnCall[] = [];
  const ptys: FakePty[] = [];
  const spawn: PtySpawn = (file, args, opts) => {
    const pty = new FakePty(1000 + ptys.length);
    calls.push({ file, args, opts });
    ptys.push(pty);
    return pty;
  };
  return { spawn, resolver: async () => spawn, calls, ptys };
}
