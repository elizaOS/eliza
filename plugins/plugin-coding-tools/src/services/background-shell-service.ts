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
  type WorkspaceDeltaReceipt,
} from "@elizaos/core";
import {
  type HostShellProcess,
  type ShellSandboxBackend,
  signalHostProcessGroup,
  startBackgroundShellOnHost,
} from "../lib/run-shell.js";
import {
  finishLocalWorkspaceDeltaObservation,
  indeterminateWorkspaceDeltaReceipt,
  type LocalWorkspaceDeltaObservation,
} from "../lib/workspace-delta.js";
import { redactShellText } from "../shell/redaction.js";
import { BACKGROUND_SHELL_SERVICE, CODING_TOOLS_LOG_PREFIX } from "../types.js";

const DEFAULT_BUFFER_CHARS = 1_000_000;
const DEFAULT_KILL_GRACE_MS = 1_500;
const DEFAULT_REAP_WAIT_MS = 3_000;
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
  status: "running" | "terminating" | "exited" | "killed" | "error";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  sandbox: ShellSandboxBackend;
  stdoutOffset: number;
  stderrOffset: number;
  workspaceDeltaReceipt?: WorkspaceDeltaReceipt;
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
  status: "running" | "terminating" | "exited" | "killed" | "error";
  terminalStatusAfterClose?: "killed" | "error";
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
  workspaceObservation?: LocalWorkspaceDeltaObservation;
  workspaceDeltaReceipt?: WorkspaceDeltaReceipt;
  workspaceDeltaPromise?: Promise<WorkspaceDeltaReceipt | undefined>;
  killTimer?: NodeJS.Timeout;
}

export class BackgroundShellStartError extends Error {
  constructor(
    message: string,
    readonly handle: string,
  ) {
    super(message);
    this.name = "BackgroundShellStartError";
  }
}

export class BackgroundShellReapTimeoutError extends Error {
  constructor(readonly handle: string) {
    super(
      `background shell reap was not proven before its deadline: ${handle}`,
    );
    this.name = "BackgroundShellReapTimeoutError";
  }
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
  private reapWaitMs = DEFAULT_REAP_WAIT_MS;

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
    svc.reapWaitMs = readPositiveIntSetting(
      runtime,
      "CODING_TOOLS_BACKGROUND_SHELL_REAP_WAIT_MS",
      DEFAULT_REAP_WAIT_MS,
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
    workspaceObservation?: LocalWorkspaceDeltaObservation;
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
      workspaceObservation: args.workspaceObservation,
      workspaceDeltaReceipt: args.workspaceObservation
        ? indeterminateWorkspaceDeltaReceipt(
            args.workspaceObservation,
            "BACKGROUND_RECEIPT_PENDING",
            handle,
          )
        : undefined,
    };
    this.sessions.set(handle, session);
    started.process.on("close", (code, signal) => {
      if (session.killTimer) clearTimeout(session.killTimer);
      if (session.status === "running") {
        session.status = "exited";
      } else if (session.status === "terminating") {
        session.status = session.terminalStatusAfterClose ?? "error";
      }
      session.exitCode = code;
      session.signal = signal;
      session.endedAt = Date.now();
      void this.finalizeWorkspaceDelta(session);
    });
    started.process.on("error", (error) => {
      session.status = "terminating";
      session.terminalStatusAfterClose = "error";
      session.exitCode = null;
      this.refreshPendingWorkspaceReceipt(session);
      appendSessionOutput(
        this.runtime,
        session,
        "stderr",
        error.message,
        this.bufferChars,
      );
    });
    if (!started.process.stdout || !started.process.stderr) {
      signalHostProcessGroup(started.process, "SIGKILL");
      session.status = "terminating";
      session.terminalStatusAfterClose = "error";
      this.refreshPendingWorkspaceReceipt(session);
      throw new BackgroundShellStartError(
        "background shell process did not expose output streams",
        handle,
      );
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
      if (session.outputLimitExceeded) this.scheduleTermination(session);
    });
    started.process.stderr.on("data", (chunk: string) => {
      appendSessionOutput(
        this.runtime,
        session,
        "stderr",
        chunk,
        this.bufferChars,
      );
      if (session.outputLimitExceeded) this.scheduleTermination(session);
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
    return snapshot(this.runtime, session);
  }

  async poll(args: {
    conversationId: string;
    handle: string;
    stdoutOffset?: number;
    stderrOffset?: number;
  }): Promise<BackgroundShellPollResult> {
    const session = this.requireSession(args.conversationId, args.handle);
    if (session.endedAt !== null) await this.finalizeWorkspaceDelta(session);
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

  async inspect(args: {
    conversationId: string;
    handle: string;
  }): Promise<BackgroundShellSessionSnapshot> {
    const session = this.requireSession(args.conversationId, args.handle);
    if (session.endedAt !== null) await this.finalizeWorkspaceDelta(session);
    return snapshot(this.runtime, session);
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
    if (session.endedAt !== null) {
      await this.finalizeWorkspaceDelta(session);
      return snapshot(this.runtime, session);
    }
    if (session.status === "running") {
      session.status = "terminating";
      session.terminalStatusAfterClose = "killed";
    }
    this.refreshPendingWorkspaceReceipt(session);
    this.scheduleTermination(session);
    try {
      session.process.stdin?.end();
    } catch (error) {
      // error-policy:J6 best-effort teardown; stdin may already be closed while
      // the process is exiting after SIGTERM.
      coreLogger.debug(
        `${CODING_TOOLS_LOG_PREFIX} background SHELL stdin close failed handle=${session.handle}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let reapTimer: NodeJS.Timeout | undefined;
    const closed = await Promise.race([
      new Promise<true>((resolve) => {
        if (session.endedAt !== null) resolve(true);
        else session.process.once("close", () => resolve(true));
      }),
      new Promise<false>((resolve) => {
        reapTimer = setTimeout(
          () => resolve(false),
          this.killGraceMs + this.reapWaitMs,
        );
        reapTimer.unref?.();
      }),
    ]);
    if (reapTimer) clearTimeout(reapTimer);
    if (!closed) throw new BackgroundShellReapTimeoutError(session.handle);
    if (session.endedAt === null) {
      throw new Error(
        `background shell did not emit close after process reap: ${session.handle}`,
      );
    }
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} background SHELL reaped handle=${session.handle} pid=${session.pid ?? "unknown"}`,
    );
    await this.finalizeWorkspaceDelta(session);
    return snapshot(this.runtime, session);
  }

  private scheduleTermination(session: BackgroundShellSession): void {
    signalHostProcessGroup(session.process, "SIGTERM");
    if (session.killTimer || session.endedAt !== null) return;
    session.killTimer = setTimeout(() => {
      if (session.endedAt === null) {
        signalHostProcessGroup(session.process, "SIGKILL");
      }
    }, this.killGraceMs);
    session.killTimer.unref?.();
  }

  private async finalizeWorkspaceDelta(
    session: BackgroundShellSession,
  ): Promise<WorkspaceDeltaReceipt | undefined> {
    if (!session.workspaceObservation) return session.workspaceDeltaReceipt;
    if (!session.workspaceDeltaPromise) {
      session.workspaceDeltaPromise = finishLocalWorkspaceDeltaObservation(
        session.workspaceObservation,
        session.handle,
        session.status === "exited" ||
          session.status === "killed" ||
          session.status === "error"
          ? session.status
          : "error",
      ).then((receipt) => {
        session.workspaceDeltaReceipt = receipt;
        session.workspaceObservation = undefined;
        return receipt;
      });
    }
    return session.workspaceDeltaPromise;
  }

  private refreshPendingWorkspaceReceipt(
    session: BackgroundShellSession,
  ): void {
    if (
      !session.workspaceObservation ||
      session.workspaceDeltaReceipt?.reasonCode !== "BACKGROUND_RECEIPT_PENDING"
    ) {
      return;
    }
    session.workspaceDeltaReceipt = indeterminateWorkspaceDeltaReceipt(
      session.workspaceObservation,
      "BACKGROUND_RECEIPT_PENDING",
      session.handle,
      session.status === "terminating" ? "terminating" : "running",
    );
  }

  private ensureCapacity(conversationId: string): void {
    const completed = [...this.sessions.values()]
      .filter((session) => session.endedAt !== null)
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
    session.status = "terminating";
    session.terminalStatusAfterClose = "error";
    session.exitCode = null;
    session.signal = null;
    session.workspaceDeltaReceipt = session.workspaceObservation
      ? indeterminateWorkspaceDeltaReceipt(
          session.workspaceObservation,
          "BACKGROUND_RECEIPT_PENDING",
          session.handle,
          "terminating",
        )
      : session.workspaceDeltaReceipt;
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
    workspaceDeltaReceipt: session.workspaceDeltaReceipt,
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
