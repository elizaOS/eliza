/**
 * Per-conversation background shell sessions for long-running coding commands.
 *
 * The service owns child process groups, stable handles, stdin writes, and
 * bounded stdout/stderr buffers. Polling uses absolute character offsets per stream:
 * when a caller asks for an offset older than the retained ring window, the
 * returned chunk starts at the retained floor and reports `truncatedBefore` so
 * the caller can distinguish lost output from an empty incremental read.
 */
import {
  logger as coreLogger,
  type IAgentRuntime,
  Service,
} from "@elizaos/core";
import {
  type HostShellProcess,
  type ShellSandboxBackend,
  signalHostProcessGroup,
  startBackgroundShellOnHost,
} from "../lib/run-shell.js";
import { BACKGROUND_SHELL_SERVICE, CODING_TOOLS_LOG_PREFIX } from "../types.js";

const DEFAULT_BUFFER_CHARS = 64_000;
const DEFAULT_KILL_GRACE_MS = 1_500;
const MAX_WRITE_CHARS = 1_000_000;
const MAX_SESSIONS_PER_CONVERSATION = 16;
const MAX_SESSIONS_GLOBAL = 128;

export interface BackgroundShellChunk {
  text: string;
  startOffset: number;
  endOffset: number;
  truncatedBefore: number;
}

export interface BackgroundShellSessionSnapshot {
  handle: string;
  conversationId: string;
  command: string;
  cwd: string;
  pid?: number;
  status: "running" | "exited" | "killed" | "error";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  sandbox: ShellSandboxBackend;
  stdoutOffset: number;
  stderrOffset: number;
}

export interface BackgroundShellPollResult
  extends BackgroundShellSessionSnapshot {
  stdout: BackgroundShellChunk;
  stderr: BackgroundShellChunk;
}

interface StreamRing {
  text: string;
  startOffset: number;
  endOffset: number;
  truncatedBefore: number;
}

interface BackgroundShellSession {
  handle: string;
  conversationId: string;
  command: string;
  cwd: string;
  process: HostShellProcess;
  pid?: number;
  status: "running" | "exited" | "killed" | "error";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  endedAt: number | null;
  sandbox: ShellSandboxBackend;
  stdout: StreamRing;
  stderr: StreamRing;
  stdinError?: Error;
  killTimer?: NodeJS.Timeout;
}

export class BackgroundShellService extends Service {
  static serviceType = BACKGROUND_SHELL_SERVICE;
  capabilityDescription =
    "Per-conversation background shell process manager for coding tools.";

  private sessions = new Map<string, BackgroundShellSession>();
  private handleCounter = 0;
  private bufferChars = DEFAULT_BUFFER_CHARS;
  private killGraceMs = DEFAULT_KILL_GRACE_MS;

  static async start(runtime: IAgentRuntime): Promise<BackgroundShellService> {
    const svc = new BackgroundShellService(runtime);
    svc.bufferChars = readPositiveIntSetting(
      runtime,
      "CODING_TOOLS_BACKGROUND_SHELL_BUFFER_CHARS",
      DEFAULT_BUFFER_CHARS,
    );
    svc.killGraceMs = readPositiveIntSetting(
      runtime,
      "CODING_TOOLS_BACKGROUND_SHELL_KILL_GRACE_MS",
      DEFAULT_KILL_GRACE_MS,
    );
    return svc;
  }

  async stop(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((session) => this.killSession(session)));
    this.sessions.clear();
  }

  startSession(args: {
    conversationId: string;
    command: string;
    cwd: string;
  }): BackgroundShellSessionSnapshot {
    this.ensureCapacity(args.conversationId);
    const handle = this.nextHandle(args.conversationId);
    const started = startBackgroundShellOnHost(this.runtime, {
      command: args.command,
      cwd: args.cwd,
    });
    const session: BackgroundShellSession = {
      handle,
      conversationId: args.conversationId,
      command: args.command,
      cwd: args.cwd,
      process: started.process,
      pid: started.pid,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: started.startedAt,
      endedAt: null,
      sandbox: started.sandbox,
      stdout: emptyRing(),
      stderr: emptyRing(),
    };
    if (!started.process.stdout || !started.process.stderr) {
      signalHostProcessGroup(started.process, "SIGKILL");
      throw new Error("background shell process did not expose output streams");
    }
    started.process.stdout.on("data", (chunk: Buffer) => {
      appendRing(session.stdout, chunk.toString("utf8"), this.bufferChars);
    });
    started.process.stderr.on("data", (chunk: Buffer) => {
      appendRing(session.stderr, chunk.toString("utf8"), this.bufferChars);
    });
    started.process.stdin?.on?.("error", (error: Error) => {
      session.stdinError = error;
      appendRing(
        session.stderr,
        `[stdin unavailable: ${error.message}]`,
        this.bufferChars,
      );
    });
    started.process.on("close", (code, signal) => {
      if (session.killTimer) clearTimeout(session.killTimer);
      if (session.status === "running") {
        session.status = "exited";
      }
      session.exitCode = code;
      session.signal = signal;
      session.endedAt = Date.now();
    });
    started.process.on("error", (error) => {
      session.status = "error";
      session.exitCode = -1;
      session.signal = null;
      session.endedAt = Date.now();
      appendRing(session.stderr, error.message, this.bufferChars);
    });
    this.sessions.set(handle, session);
    return snapshot(session);
  }

  poll(args: {
    conversationId: string;
    handle: string;
    stdoutOffset?: number;
    stderrOffset?: number;
  }): BackgroundShellPollResult {
    const session = this.requireSession(args.conversationId, args.handle);
    return {
      ...snapshot(session),
      stdout: readRing(session.stdout, args.stdoutOffset),
      stderr: readRing(session.stderr, args.stderrOffset),
    };
  }

  list(conversationId: string): BackgroundShellSessionSnapshot[] {
    return [...this.sessions.values()]
      .filter((session) => session.conversationId === conversationId)
      .map((session) => snapshot(session));
  }

  write(args: {
    conversationId: string;
    handle: string;
    stdin: string;
  }): BackgroundShellSessionSnapshot {
    const session = this.requireSession(args.conversationId, args.handle);
    if (session.status !== "running") {
      throw new Error(
        `background shell session is not running: ${args.handle}`,
      );
    }
    if (
      !session.process.stdin ||
      session.process.stdin.destroyed ||
      session.process.stdin.writableEnded ||
      session.stdinError
    ) {
      throw new Error(`background shell stdin is unavailable: ${args.handle}`);
    }
    if (args.stdin.length > MAX_WRITE_CHARS) {
      throw new Error(
        `stdin payload is too large: ${args.stdin.length} > ${MAX_WRITE_CHARS}`,
      );
    }
    session.process.stdin.write(args.stdin);
    return snapshot(session);
  }

  async kill(args: {
    conversationId: string;
    handle: string;
  }): Promise<BackgroundShellSessionSnapshot> {
    const session = this.requireSession(args.conversationId, args.handle);
    await this.killSession(session);
    return snapshot(session);
  }

  private async killSession(
    session: BackgroundShellSession,
  ): Promise<BackgroundShellSessionSnapshot> {
    if (session.status !== "running") return snapshot(session);
    session.status = "killed";
    signalHostProcessGroup(session.process, "SIGTERM");
    try {
      session.process.stdin?.end();
    } catch (error) {
      // error-policy:J6 best-effort teardown; stdin may already be closed while
      // the process is exiting after SIGTERM.
      coreLogger.debug(
        `${CODING_TOOLS_LOG_PREFIX} background SHELL stdin close failed handle=${session.handle}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    session.killTimer = setTimeout(() => {
      if (session.endedAt === null) {
        signalHostProcessGroup(session.process, "SIGKILL");
      }
    }, this.killGraceMs);
    if (typeof session.killTimer.unref === "function") {
      session.killTimer.unref();
    }
    await new Promise<void>((resolve) => {
      if (session.endedAt !== null) {
        resolve();
        return;
      }
      session.process.once("close", () => resolve());
    });
    if (session.endedAt === null) {
      session.endedAt = Date.now();
    }
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} background SHELL reaped handle=${session.handle} pid=${session.pid ?? "unknown"}`,
    );
    return snapshot(session);
  }

  private ensureCapacity(conversationId: string): void {
    const completed = [...this.sessions.values()]
      .filter((session) => session.status !== "running")
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    const conversationCount = () =>
      [...this.sessions.values()].filter(
        (session) => session.conversationId === conversationId,
      ).length;

    for (const session of completed) {
      if (
        conversationCount() < MAX_SESSIONS_PER_CONVERSATION &&
        this.sessions.size < MAX_SESSIONS_GLOBAL
      ) {
        break;
      }
      this.sessions.delete(session.handle);
    }

    if (conversationCount() >= MAX_SESSIONS_PER_CONVERSATION) {
      throw new Error(
        `background shell session limit reached for this conversation (${MAX_SESSIONS_PER_CONVERSATION})`,
      );
    }
    if (this.sessions.size >= MAX_SESSIONS_GLOBAL) {
      throw new Error(
        `global background shell session limit reached (${MAX_SESSIONS_GLOBAL})`,
      );
    }
  }

  private requireSession(
    conversationId: string,
    handle: string,
  ): BackgroundShellSession {
    const session = this.sessions.get(handle);
    if (!session || session.conversationId !== conversationId) {
      throw new Error(`background shell session not found: ${handle}`);
    }
    return session;
  }

  private nextHandle(conversationId: string): string {
    this.handleCounter += 1;
    const suffix = this.handleCounter.toString(36).padStart(4, "0");
    const scope = conversationId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8);
    return `bgsh_${scope}_${Date.now().toString(36)}_${suffix}`;
  }
}

function emptyRing(): StreamRing {
  return { text: "", startOffset: 0, endOffset: 0, truncatedBefore: 0 };
}

function appendRing(ring: StreamRing, text: string, cap: number): void {
  if (!text) return;
  ring.text += text;
  ring.endOffset += text.length;
  if (ring.text.length > cap) {
    const drop = ring.text.length - cap;
    ring.text = ring.text.slice(drop);
    ring.startOffset += drop;
    ring.truncatedBefore = ring.startOffset;
  }
}

function readRing(
  ring: StreamRing,
  requestedOffset?: number,
): BackgroundShellChunk {
  const offset =
    requestedOffset === undefined || !Number.isFinite(requestedOffset)
      ? ring.startOffset
      : Math.max(0, Math.floor(requestedOffset));
  const start = Math.max(offset, ring.startOffset);
  const index = start - ring.startOffset;
  return {
    text: ring.text.slice(index),
    startOffset: start,
    endOffset: ring.endOffset,
    truncatedBefore: ring.truncatedBefore,
  };
}

function snapshot(
  session: BackgroundShellSession,
): BackgroundShellSessionSnapshot {
  return {
    handle: session.handle,
    conversationId: session.conversationId,
    command: session.command,
    cwd: session.cwd,
    pid: session.pid,
    status: session.status,
    exitCode: session.exitCode,
    signal: session.signal,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMs: (session.endedAt ?? Date.now()) - session.startedAt,
    sandbox: session.sandbox,
    stdoutOffset: session.stdout.endOffset,
    stderrOffset: session.stderr.endOffset,
  };
}

function readPositiveIntSetting(
  runtime: IAgentRuntime,
  key: string,
  fallback: number,
): number {
  const fromRuntime = runtime.getSetting(key);
  const raw =
    typeof fromRuntime === "string" || typeof fromRuntime === "number"
      ? fromRuntime
      : process.env[key];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
