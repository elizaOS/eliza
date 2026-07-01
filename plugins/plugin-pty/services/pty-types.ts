/**
 * Types for the PTY service: the minimal `@lydell/node-pty` surface we use, the
 * spawn spec a caller submits, and the live-session record we track.
 *
 * We depend on `@lydell/node-pty` only through {@link PtySpawn}/{@link PtyHandle}
 * so the whole service is unit-testable with an injected fake PTY — no native
 * module required to exercise the bridge, session lifecycle, or routing logic.
 */

/** A disposable subscription returned by node-pty's `onData`/`onExit`. */
export interface PtyDisposable {
  dispose(): void;
}

/** The subset of node-pty's `IPty` this service uses. */
export interface PtyHandle {
  readonly pid?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): PtyDisposable | undefined;
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): PtyDisposable | undefined;
}

/** node-pty's `spawn(file, args, opts)` signature (the parts we pass). */
export type PtySpawn = (
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    name?: string;
    cols?: number;
    rows?: number;
  },
) => PtyHandle;

/** A fully-resolved spawn request handed to {@link PtySessionStore.start}. */
export interface PtySpawnSpec {
  /** Executable to run (e.g. an absolute node path, or `eliza-code`). */
  command: string;
  /** Arguments passed to the executable. */
  args: string[];
  /** Working directory; the session is confined here. */
  cwd: string;
  /**
   * Explicit environment for the PTY child. The store combines allowed keys from
   * this object with a small safe process-env allowlist; it does not inherit the
   * full server environment.
   */
  env?: Record<string, string | undefined>;
  /** Initial terminal size. Defaults to 120x30. */
  cols?: number;
  rows?: number;
  /** Human-readable label surfaced in session listings (e.g. "eliza-code · fast"). */
  label?: string;
  /** Free-form origin tag for auditing (e.g. "cockpit", "eliza-code"). */
  kind?: string;
  /** Stable UI/WebSocket client id that owns this session, when spawned by a browser. */
  ownerClientId?: string;
}

/** Public, serializable metadata for one live session (no PTY handle leaked). */
export interface PtySessionInfo {
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  label?: string;
  kind?: string;
  ownerClientId?: string;
  pid?: number;
  createdAt: number;
  exited: boolean;
  exitCode?: number | null;
}
