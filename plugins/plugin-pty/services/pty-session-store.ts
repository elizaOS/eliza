import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { logger } from "@elizaos/core";
import { bunTruePtySpawn, isBunRuntime } from "./bun-pty-spawn";
import type { ConsoleBridge, SessionExitEvent, SessionOutputEvent } from "./pty-contract";
import type {
  PtyDisposable,
  PtyHandle,
  PtySessionInfo,
  PtySpawn,
  PtySpawnSpec,
} from "./pty-types";

/** Default terminal geometry when a caller doesn't specify one. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
/** Hard cap on concurrent live sessions — a runaway backstop, not a real limit. */
const DEFAULT_MAX_SESSIONS = 24;
/** How long an exited session's record lingers for a final drain before removal. */
const EXITED_SESSION_TTL_MS = 15_000;

/** Resolves the node-pty `spawn` implementation lazily (native, optional dep). */
export type PtySpawnResolver = () => Promise<PtySpawn>;

/** One live session: the PTY handle plus bookkeeping and its I/O subscriptions. */
interface LiveSession {
  info: PtySessionInfo;
  pty: PtyHandle;
  disposers: PtyDisposable[];
  reapTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The default spawn resolver picks the PTY engine by runtime:
 *   • Bun  → Bun's native truePty (`Bun.spawn({ terminal })`). node-pty's write
 *            path is broken under Bun, so we use Bun's own terminal — the same
 *            engine the Electrobun host uses.
 *   • Node → `@lydell/node-pty` (an optional native dep), which works end to end.
 * Both are adapted to the same {@link PtyHandle}, so the store is engine-agnostic.
 */
export const defaultSpawnResolver: PtySpawnResolver = async () => {
  if (isBunRuntime()) {
    return bunTruePtySpawn;
  }
  const mod = (await import("@lydell/node-pty")) as {
    spawn?: PtySpawn;
    default?: { spawn?: PtySpawn };
  };
  const spawn = mod.spawn ?? mod.default?.spawn;
  if (typeof spawn !== "function") {
    throw new Error(
      "PTY support unavailable: @lydell/node-pty did not expose a spawn() function.",
    );
  }
  return spawn;
};

/**
 * The {@link ConsoleBridge} the agent server drives over WebSocket. It emits
 * `session_output` (per-session stdout) and `session_exit`, and forwards
 * `writeRaw`/`resize` to the owning {@link PtySessionStore}. Composed around a
 * plain `EventEmitter` so the on/off/writeRaw/resize signatures match the
 * consumer contract exactly.
 */
export class PtyConsoleBridge implements ConsoleBridge {
  private readonly emitter = new EventEmitter();
  private store: PtySessionStore | null = null;

  constructor() {
    // Sessions can outnumber the default listener cap when many terminals are
    // open; raise it so Node doesn't warn about a "leak" that is intentional.
    this.emitter.setMaxListeners(0);
  }

  /** Wired once by the store that owns this bridge (avoids a constructor cycle). */
  attachStore(store: PtySessionStore): void {
    this.store = store;
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.emitter.on(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.emitter.off(event, listener);
  }

  writeRaw(sessionId: string, data: string): void {
    this.store?.write(sessionId, data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.store?.resize(sessionId, cols, rows);
  }

  /** Internal: publish a chunk of PTY output for `sessionId`. */
  emitOutput(sessionId: string, data: string): void {
    const payload: SessionOutputEvent = { sessionId, data };
    this.emitter.emit("session_output", payload);
  }

  /** Internal: publish a session's process exit. */
  emitExit(sessionId: string, exitCode: number | null): void {
    const payload: SessionExitEvent = { sessionId, exitCode };
    this.emitter.emit("session_exit", payload);
  }
}

/**
 * Owns the live PTY sessions: spawns them via an injectable resolver, streams
 * their output through the bridge, and routes keystrokes/resizes/kills back to
 * the right process. All cwd's are confined to {@link allowedRoot}.
 */
export class PtySessionStore {
  private readonly sessions = new Map<string, LiveSession>();
  private resolvedSpawn: PtySpawn | null = null;

  constructor(
    readonly bridge: PtyConsoleBridge,
    private readonly resolveSpawn: PtySpawnResolver = defaultSpawnResolver,
    private readonly opts: { allowedRoot?: string; maxSessions?: number } = {},
  ) {
    bridge.attachStore(this);
  }

  private get maxSessions(): number {
    return this.opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /** Number of live (spawned, not-yet-reaped) sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Reject a cwd that escapes the allowed root (defense in depth — the route
   * and spec builder already resolve a safe cwd, but the store is the last gate
   * before spawning a real process).
   */
  private confineCwd(cwd: string): string {
    const resolved = path.resolve(cwd);
    const root = this.opts.allowedRoot ? path.resolve(this.opts.allowedRoot) : null;
    if (root) {
      const rel = path.relative(root, resolved);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
        return resolved;
      }
      throw new Error(
        `PTY cwd "${resolved}" is outside the allowed root "${root}".`,
      );
    }
    return resolved;
  }

  /** Spawn a new interactive session and start streaming its output. */
  async start(spec: PtySpawnSpec): Promise<PtySessionInfo> {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `PTY session limit reached (${this.maxSessions}); stop a session before starting another.`,
      );
    }
    const cwd = this.confineCwd(spec.cwd);
    if (!this.resolvedSpawn) {
      this.resolvedSpawn = await this.resolveSpawn();
    }
    const spawn = this.resolvedSpawn;

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...(spec.env ?? {}),
      TERM: spec.env?.TERM ?? process.env.TERM ?? "xterm-256color",
    };

    const pty = spawn(spec.command, spec.args, {
      cwd,
      env,
      name: env.TERM,
      cols: spec.cols ?? DEFAULT_COLS,
      rows: spec.rows ?? DEFAULT_ROWS,
    });

    const sessionId = randomUUID();
    const info: PtySessionInfo = {
      sessionId,
      command: spec.command,
      args: spec.args,
      cwd,
      label: spec.label,
      kind: spec.kind,
      pid: pty.pid,
      createdAt: Date.now(),
      exited: false,
      exitCode: undefined,
    };

    const disposers: PtyDisposable[] = [];
    const onData = pty.onData((data) => {
      this.bridge.emitOutput(sessionId, data);
    });
    if (onData) disposers.push(onData);
    const onExit = pty.onExit(({ exitCode }) => {
      this.handleExit(sessionId, exitCode ?? null);
    });
    if (onExit) disposers.push(onExit);

    this.sessions.set(sessionId, { info, pty, disposers });
    logger.info(
      `[plugin-pty] started session ${sessionId} (${spec.label ?? spec.command}) pid=${pty.pid ?? "?"} cwd=${cwd}`,
    );
    return { ...info };
  }

  /** Forward a keystroke chunk to the session's PTY. */
  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.info.exited) return;
    try {
      session.pty.write(data);
    } catch (err) {
      logger.warn(`[plugin-pty] write to session ${sessionId} failed: ${String(err)}`);
    }
  }

  /** Resize the session's PTY. Ignores non-finite/degenerate geometry. */
  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.info.exited) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) {
      return;
    }
    try {
      session.pty.resize(Math.floor(cols), Math.floor(rows));
    } catch (err) {
      logger.warn(`[plugin-pty] resize of session ${sessionId} failed: ${String(err)}`);
    }
  }

  /** Kill a session's process now and remove its record. */
  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.reapTimer) clearTimeout(session.reapTimer);
    try {
      if (!session.info.exited) session.pty.kill();
    } catch (err) {
      logger.warn(`[plugin-pty] kill of session ${sessionId} failed: ${String(err)}`);
    }
    for (const d of session.disposers) {
      try {
        d.dispose();
      } catch {
        // best-effort teardown
      }
    }
    this.sessions.delete(sessionId);
    logger.info(`[plugin-pty] stopped session ${sessionId}`);
  }

  /** Kill every live session (used on service shutdown). */
  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  /** Serializable metadata for every live session. */
  list(): PtySessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }));
  }

  /** Whether a session currently exists (live or draining). */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private handleExit(sessionId: string, exitCode: number | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.info.exited = true;
    session.info.exitCode = exitCode;
    this.bridge.emitExit(sessionId, exitCode);
    logger.info(`[plugin-pty] session ${sessionId} exited (code=${exitCode ?? "null"})`);
    // Keep the record briefly so a just-connected client can drain the tail,
    // then reap it.
    session.reapTimer = setTimeout(() => {
      const still = this.sessions.get(sessionId);
      if (still) {
        for (const d of still.disposers) {
          try {
            d.dispose();
          } catch {
            // best-effort
          }
        }
        this.sessions.delete(sessionId);
      }
    }, EXITED_SESSION_TTL_MS);
    // Don't hold the event loop open for the reap timer.
    session.reapTimer.unref?.();
  }
}
