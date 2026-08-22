/**
 * Per-conversation background shell sessions for long-running coding commands.
 *
 * The service owns child process groups, stable handles, stdin writes, and
 * complete stdout/stderr capture. A real resource ceiling terminates the
 * process and makes polling fail explicitly; partial output is never presented
 * to the planner as though it were complete.
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
import { redactShellText } from "../shell/redaction.js";
import { BACKGROUND_SHELL_SERVICE, CODING_TOOLS_LOG_PREFIX } from "../types.js";

const DEFAULT_BUFFER_CHARS = 1_000_000;
const DEFAULT_KILL_GRACE_MS = 1_500;
const MAX_WRITE_CHARS = 1_000_000;
const MAX_SESSIONS_PER_CONVERSATION = 16;
const MAX_SESSIONS_GLOBAL = 128;

type SecretFragment = Parameters<
  IAgentRuntime["locateConfiguredSecretFragmentTaint"]
>[0][number];
type SecretTaintRange = Extract<
  ReturnType<IAgentRuntime["locateConfiguredSecretFragmentTaint"]>,
  { status: "complete" }
>["ranges"][number];

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
  redaction: FragmentRedactionState;
  stdinError?: Error;
  outputLimitExceeded?: boolean;
  killTimer?: NodeJS.Timeout;
}

interface FragmentRedactionState {
  fragments: SecretFragment[];
  ranges: SecretTaintRange[];
  incomplete: boolean;
  quarantineCharacters: Record<"stdout" | "stderr", number>;
  profileRevision?: number;
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
      redaction: emptyFragmentRedactionState(),
    };
    if (!started.process.stdout || !started.process.stderr) {
      signalHostProcessGroup(started.process, "SIGKILL");
      throw new Error("background shell process did not expose output streams");
    }
    // Decode before ring/redaction processing so chunk boundaries cannot
    // replace valid partial code points with U+FFFD.
    started.process.stdout.setEncoding("utf8");
    started.process.stderr.setEncoding("utf8");
    started.process.stdout.on("data", (chunk: string) => {
      appendSessionOutput(
        this.runtime,
        session,
        "stdout",
        chunk,
        this.bufferChars,
      );
    });
    started.process.stderr.on("data", (chunk: string) => {
      appendSessionOutput(
        this.runtime,
        session,
        "stderr",
        chunk,
        this.bufferChars,
      );
    });
    started.process.stdin?.on?.("error", (error: Error) => {
      session.stdinError = error;
      appendSessionOutput(
        this.runtime,
        session,
        "stderr",
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
      appendSessionOutput(
        this.runtime,
        session,
        "stderr",
        error.message,
        this.bufferChars,
      );
    });
    this.sessions.set(handle, session);
    return snapshot(this.runtime, session);
  }

  poll(args: {
    conversationId: string;
    handle: string;
    stdoutOffset?: number;
    stderrOffset?: number;
  }): BackgroundShellPollResult {
    const session = this.requireSession(args.conversationId, args.handle);
    if (session.outputLimitExceeded) {
      throw new Error(
        `background shell output exceeded the ${this.bufferChars}-character complete-capture safety limit; no partial output is available`,
      );
    }
    refreshSessionRedaction(this.runtime, session);
    return {
      ...snapshot(this.runtime, session),
      stdout: readRing(
        this.runtime,
        session,
        "stdout",
        session.stdout,
        args.stdoutOffset,
      ),
      stderr: readRing(
        this.runtime,
        session,
        "stderr",
        session.stderr,
        args.stderrOffset,
      ),
    };
  }

  list(conversationId: string): BackgroundShellSessionSnapshot[] {
    return [...this.sessions.values()]
      .filter((session) => session.conversationId === conversationId)
      .map((session) => snapshot(this.runtime, session));
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
    return snapshot(this.runtime, session);
  }

  async kill(args: {
    conversationId: string;
    handle: string;
  }): Promise<BackgroundShellSessionSnapshot> {
    const session = this.requireSession(args.conversationId, args.handle);
    await this.killSession(session);
    return snapshot(this.runtime, session);
  }

  private async killSession(
    session: BackgroundShellSession,
  ): Promise<BackgroundShellSessionSnapshot> {
    if (session.status !== "running") return snapshot(this.runtime, session);
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
    return snapshot(this.runtime, session);
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

function emptyFragmentRedactionState(): FragmentRedactionState {
  return {
    fragments: [],
    ranges: [],
    incomplete: false,
    quarantineCharacters: { stdout: 0, stderr: 0 },
  };
}

function appendSessionOutput(
  runtime: IAgentRuntime,
  session: BackgroundShellSession,
  source: "stdout" | "stderr",
  text: string,
  cap: number,
): void {
  if (!text) return;
  if (session.outputLimitExceeded) return;
  if (
    session.stdout.text.length + session.stderr.text.length + text.length >
    cap
  ) {
    session.outputLimitExceeded = true;
    session.status = "error";
    session.exitCode = -1;
    session.endedAt = Date.now();
    session.stdout = emptyRing();
    session.stderr = emptyRing();
    session.redaction = emptyFragmentRedactionState();
    signalHostProcessGroup(session.process, "SIGTERM");
    return;
  }
  const ring = session[source];
  const startOffset = ring.endOffset;
  const profile = runtime.locateConfiguredSecretFragmentTaint([
    { source, startOffset, text: "x" },
  ]);
  const maxSecretLength = profile.maxSecretLength;
  appendRing(ring, text, cap, maxSecretLength);
  const quarantinedCharacters = Math.min(
    session.redaction.quarantineCharacters[source],
    text.length,
  );
  if (quarantinedCharacters > 0) {
    session.redaction.ranges = mergeTaintRanges([
      ...session.redaction.ranges,
      {
        source,
        startOffset,
        endOffset: startOffset + quarantinedCharacters,
      },
    ]);
    session.redaction.quarantineCharacters[source] -= quarantinedCharacters;
  }
  const detectionText = text.slice(quarantinedCharacters);
  if (detectionText) {
    session.redaction.fragments.push({
      source,
      startOffset: startOffset + quarantinedCharacters,
      text: detectionText,
    });
  }
  refreshSessionRedaction(runtime, session);
  pruneDetectionFragments(session);
}

function refreshSessionRedaction(
  runtime: IAgentRuntime,
  session: BackgroundShellSession,
): void {
  if (session.redaction.incomplete) return;
  const analyses = observableFragmentOrders(session.redaction.fragments).map(
    (fragments) => runtime.locateConfiguredSecretFragmentTaint(fragments),
  );
  const revisions = new Set(
    analyses.map((analysis) => analysis.profileRevision),
  );
  if (revisions.size !== 1) {
    session.redaction.incomplete = true;
    return;
  }
  const revision = analyses[0]?.profileRevision ?? 0;
  if (
    session.redaction.profileRevision !== undefined &&
    revision !== session.redaction.profileRevision
  ) {
    session.redaction.incomplete = true;
    session.redaction.ranges = mergeTaintRanges([
      ...session.redaction.ranges,
      ...retainedRingRanges(session),
    ]);
    session.redaction.fragments = [];
    return;
  }
  session.redaction.profileRevision = revision;
  const incomplete = analyses.find(
    (analysis) => analysis.status === "incomplete",
  );
  if (incomplete) {
    session.redaction.incomplete = incomplete.maxSecretLength === 0;
    if (incomplete.maxSecretLength > 0) {
      session.redaction.ranges = mergeTaintRanges([
        ...session.redaction.ranges,
        ...retainedRingRanges(session),
      ]);
      session.redaction.fragments = [];
      for (const source of ["stdout", "stderr"] as const) {
        session.redaction.quarantineCharacters[source] = Math.max(
          session.redaction.quarantineCharacters[source],
          incomplete.maxSecretLength,
        );
      }
    }
    return;
  }
  session.redaction.incomplete = false;
  session.redaction.ranges = mergeTaintRanges([
    ...session.redaction.ranges,
    ...analyses.flatMap((analysis) => analysis.ranges),
  ]);
}

function observableFragmentOrders(
  fragments: readonly SecretFragment[],
): SecretFragment[][] {
  const stdout = fragments.filter((fragment) => fragment.source === "stdout");
  const stderr = fragments.filter((fragment) => fragment.source === "stderr");
  return [[...fragments], [...stdout, ...stderr], [...stderr, ...stdout]];
}

function retainedRingRanges(
  session: BackgroundShellSession,
): SecretTaintRange[] {
  return (["stdout", "stderr"] as const).flatMap((source) => {
    const ring = session[source];
    return ring.endOffset > ring.startOffset
      ? [{ source, startOffset: ring.startOffset, endOffset: ring.endOffset }]
      : [];
  });
}

function pruneDetectionFragments(session: BackgroundShellSession): void {
  const floors = {
    stdout: session.stdout.startOffset,
    stderr: session.stderr.startOffset,
  };
  session.redaction.fragments = session.redaction.fragments.flatMap(
    (fragment) => {
      const floor = floors[fragment.source as keyof typeof floors];
      if (floor === undefined) return [];
      const endOffset = fragment.startOffset + fragment.text.length;
      if (endOffset <= floor) return [];
      if (fragment.startOffset >= floor) return [fragment];
      return [
        {
          ...fragment,
          startOffset: floor,
          text: fragment.text.slice(floor - fragment.startOffset),
        },
      ];
    },
  );
  session.redaction.ranges = session.redaction.ranges.filter((range) => {
    const floor = floors[range.source as keyof typeof floors];
    return floor !== undefined && range.endOffset > floor;
  });
}

function mergeTaintRanges(
  ranges: readonly SecretTaintRange[],
): SecretTaintRange[] {
  const sorted = [...ranges].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.startOffset - right.startOffset ||
      left.endOffset - right.endOffset,
  );
  const merged: SecretTaintRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (
      previous?.source === range.source &&
      range.startOffset <= previous.endOffset
    ) {
      previous.endOffset = Math.max(previous.endOffset, range.endOffset);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function appendRing(
  ring: StreamRing,
  text: string,
  cap: number,
  redactionOverlapChars: number,
): void {
  if (!text) return;
  ring.text += text;
  ring.endOffset += text.length;
  void cap;
  void redactionOverlapChars;
}

function readRing(
  runtime: IAgentRuntime,
  session: BackgroundShellSession,
  source: "stdout" | "stderr",
  ring: StreamRing,
  requestedOffset?: number,
): BackgroundShellChunk {
  const offset =
    requestedOffset === undefined || !Number.isFinite(requestedOffset)
      ? ring.truncatedBefore
      : Math.max(0, Math.floor(requestedOffset));
  const start = Math.min(
    ring.endOffset,
    Math.max(offset, ring.truncatedBefore),
  );
  const index = start - ring.startOffset;
  const raw = ring.text.slice(index);
  const text = projectRingText(
    runtime,
    session,
    source,
    ring,
    index,
    start,
    raw,
  );
  return {
    text,
    startOffset: start,
    endOffset: ring.endOffset,
    truncatedBefore: ring.truncatedBefore,
  };
}

function projectRingText(
  runtime: IAgentRuntime,
  session: BackgroundShellSession,
  source: "stdout" | "stderr",
  ring: StreamRing,
  index: number,
  startOffset: number,
  raw: string,
): string {
  if (!raw) return "";
  if (session.redaction.incomplete) return "";
  const endOffset = startOffset + raw.length;
  const ranges = session.redaction.ranges.filter(
    (range) =>
      range.source === source &&
      range.endOffset > startOffset &&
      range.startOffset < endOffset,
  );
  if (ranges.length === 0) {
    const redactedFull = redactShellText(runtime, ring.text);
    const redactedPrefix = redactShellText(runtime, ring.text.slice(0, index));
    return verifyProjectedText(
      runtime,
      redactedFull.startsWith(redactedPrefix)
        ? redactedFull.slice(redactedPrefix.length)
        : "",
    );
  }

  const pieces: string[] = [];
  let cursor = startOffset;
  for (const range of ranges) {
    const taintStart = Math.max(startOffset, range.startOffset);
    const taintEnd = Math.min(endOffset, range.endOffset);
    if (taintStart > cursor) {
      pieces.push(raw.slice(cursor - startOffset, taintStart - startOffset));
    }
    cursor = Math.max(cursor, taintEnd);
  }
  if (cursor < endOffset) pieces.push(raw.slice(cursor - startOffset));
  return verifyProjectedText(
    runtime,
    redactShellText(runtime, pieces.join("")),
  );
}

function verifyProjectedText(runtime: IAgentRuntime, text: string): string {
  if (!text) return "";
  const verification = runtime.locateConfiguredSecretFragmentTaint([
    { source: "projected", startOffset: 0, text },
  ]);
  return verification.status === "complete" && verification.ranges.length === 0
    ? text
    : "";
}

function snapshot(
  runtime: IAgentRuntime,
  session: BackgroundShellSession,
): BackgroundShellSessionSnapshot {
  return {
    handle: session.handle,
    conversationId: session.conversationId,
    command: redactShellText(runtime, session.command),
    cwd: redactShellText(runtime, session.cwd),
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
