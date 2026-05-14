import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import type { TerminalActionResult } from "../types.js";
import { checkDangerousCommand, sanitizeChildEnv } from "./security.js";

type PtyProcess = {
  onData: (listener: (data: string) => void) => { dispose: () => void } | void;
  onExit?: (listener: (event: { exitCode: number; signal?: number }) => void) => {
    dispose: () => void;
  } | void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
};

type PtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ) => PtyProcess;
};

type TerminalBackend = "pty" | "spawn";

export type TerminalSession = {
  id: string;
  cwd: string;
  createdAt: string;
  shell: string;
  cols: number;
  rows: number;
  backend: TerminalBackend;
  lastOutput?: string;
  exitCode?: number;
  closed?: boolean;
  process?: PtyProcess | ChildProcessWithoutNullStreams;
  buffer: string;
};

const sessions = new Map<string, TerminalSession>();
let sessionCounter = 0;
let lastOutputBuffer = "";
let cachedPtyModule: PtyModule | null | undefined;

function truncateOutput(output: string): string {
  return output.slice(-5000);
}

function appendOutput(session: TerminalSession, chunk: string): void {
  session.buffer = truncateOutput(`${session.buffer}${chunk}`);
  session.lastOutput = session.buffer;
  lastOutputBuffer = session.buffer;
}

function normalizeColsRows(params?: {
  cols?: number;
  rows?: number;
}): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.floor(params?.cols ?? 80)),
    rows: Math.max(1, Math.floor(params?.rows ?? 24)),
  };
}

function resolveInteractiveShell(shell?: string): string {
  if (shell && shell.trim().length > 0) {
    return shell.trim();
  }
  if (process.env.SHELL && process.env.SHELL.trim().length > 0) {
    return process.env.SHELL;
  }
  return process.platform === "win32" ? "powershell.exe" : "/bin/bash";
}

function resolveShell(): {
  command: string;
  argsFor: (command: string) => string[];
} {
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      argsFor: (command) => ["-NoProfile", "-Command", command],
    };
  }

  return {
    command: "/bin/bash",
    argsFor: (command) => ["-c", command],
  };
}

async function loadPtyModule(): Promise<PtyModule | null> {
  if (cachedPtyModule !== undefined) {
    return cachedPtyModule;
  }

  try {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<PtyModule>;
    cachedPtyModule = await dynamicImport("node-pty");
  } catch {
    cachedPtyModule = null;
  }

  return cachedPtyModule;
}

function makeSessionResult(session: TerminalSession): TerminalActionResult {
  return {
    success: true,
    sessionId: session.id,
    session_id: session.id,
    cwd: session.cwd,
    backend: session.backend,
    shell: session.shell,
    cols: session.cols,
    rows: session.rows,
    output: session.buffer,
    message: `Terminal session ${session.id} created.`,
  };
}

export async function connectTerminal(
  arg?: string | { cwd?: string; cols?: number; rows?: number; shell?: string },
): Promise<TerminalActionResult> {
  const cwd = typeof arg === "string" ? arg : arg?.cwd;
  const { cols, rows } = normalizeColsRows(typeof arg === "string" ? undefined : arg);
  const sessionId = `term_${++sessionCounter}`;
  const sessionCwd = cwd || os.homedir();
  const shell = resolveInteractiveShell(typeof arg === "string" ? undefined : arg?.shell);
  const env = {
    ...sanitizeChildEnv(),
    TERM: process.env.TERM || "xterm-256color",
    COLUMNS: String(cols),
    LINES: String(rows),
  };

  const pty = await loadPtyModule();
  if (pty) {
    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: sessionCwd,
      env,
    });
    const session: TerminalSession = {
      id: sessionId,
      cwd: sessionCwd,
      createdAt: new Date().toISOString(),
      shell,
      cols,
      rows,
      backend: "pty",
      process: ptyProcess,
      buffer: "",
    };
    ptyProcess.onData((data) => appendOutput(session, data));
    ptyProcess.onExit?.((event) => {
      session.exitCode = event.exitCode;
      session.closed = true;
    });
    sessions.set(sessionId, session);
    return makeSessionResult(session);
  }

  const child = spawn(shell, [], {
    cwd: sessionCwd,
    env,
    shell: false,
  });
  const session: TerminalSession = {
    id: sessionId,
    cwd: sessionCwd,
    createdAt: new Date().toISOString(),
    shell,
    cols,
    rows,
    backend: "spawn",
    process: child,
    buffer: "",
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data: string) => appendOutput(session, data));
  child.stderr.on("data", (data: string) => appendOutput(session, data));
  child.once("exit", (code) => {
    session.exitCode = code ?? -1;
    session.closed = true;
  });
  sessions.set(sessionId, session);
  return makeSessionResult(session);
}

export async function executeTerminal(params: {
  command: string;
  timeoutSeconds?: number;
  sessionId?: string;
  cwd?: string;
}): Promise<TerminalActionResult> {
  const risk = checkDangerousCommand(params.command);
  if (risk.blocked) {
    return {
      success: false,
      output: "",
      exitCode: -1,
      exit_code: -1,
      error: risk.reason,
    };
  }

  const shell = resolveShell();
  const sessionCwd =
    (params.sessionId ? sessions.get(params.sessionId)?.cwd : undefined) ||
    params.cwd ||
    os.homedir();
  const timeoutSeconds = params.timeoutSeconds ?? 30;

  return await new Promise<TerminalActionResult>((resolve) => {
    let settled = false;
    const finish = (result: TerminalActionResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = execFile(
      shell.command,
      shell.argsFor(params.command),
      {
        cwd: sessionCwd,
        timeout: timeoutSeconds * 1000,
        maxBuffer: 1024 * 1024,
        env: sanitizeChildEnv(),
      },
      (error, stdout, stderr) => {
        const output = truncateOutput(
          `${stdout}${stderr ? `\n${stderr}` : ""}`,
        );
        lastOutputBuffer = output;
        if (params.sessionId) {
          const existing = sessions.get(params.sessionId);
          if (existing) {
            existing.lastOutput = output;
            existing.buffer = output;
          }
        }
        if (!error) {
          finish({
            success: true,
            output,
            exitCode: 0,
            exit_code: 0,
            cwd: sessionCwd,
            sessionId: params.sessionId,
            session_id: params.sessionId,
          });
          return;
        }

        const exitCode =
          typeof error.code === "number" ? error.code : error.killed ? -1 : 1;
        finish({
          success: false,
          output,
          exitCode,
          exit_code: exitCode,
          cwd: sessionCwd,
          sessionId: params.sessionId,
          session_id: params.sessionId,
          error: error.message,
        });
      },
    );

    const killTimer = setTimeout(
      () => {
        child.kill("SIGKILL");
        finish({
          success: false,
          output: "",
          exitCode: -1,
          exit_code: -1,
          cwd: sessionCwd,
          sessionId: params.sessionId,
          session_id: params.sessionId,
          error: `Command timed out after ${timeoutSeconds}s.`,
        });
      },
      (timeoutSeconds + 1) * 1000,
    );

    child.once("exit", () => {
      clearTimeout(killTimer);
    });
  });
}

export function readTerminal(
  arg?: string | { session_id?: string; sessionId?: string },
): TerminalActionResult {
  const sessionId =
    typeof arg === "string" ? arg : (arg?.session_id ?? arg?.sessionId);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  const output = session?.buffer ?? session?.lastOutput ?? lastOutputBuffer;
  if (session) {
    session.buffer = "";
  }
  return {
    success: true,
    sessionId,
    session_id: sessionId,
    output,
    exitCode: session?.exitCode,
    exit_code: session?.exitCode,
    message: output.length > 0 ? undefined : "No pending terminal output.",
  };
}

export function typeTerminal(
  arg: string | { text: string; session_id?: string; sessionId?: string },
): TerminalActionResult {
  const text = typeof arg === "string" ? arg : arg.text;
  const sessionId =
    typeof arg === "string" ? undefined : (arg.session_id ?? arg.sessionId);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    return {
      success: false,
      sessionId,
      session_id: sessionId,
      error: sessionId
        ? `Terminal session ${sessionId} not found.`
        : "sessionId is required for terminal input.",
    };
  }
  if (session.closed) {
    return {
      success: false,
      sessionId,
      session_id: sessionId,
      error: `Terminal session ${sessionId} is closed.`,
    };
  }

  if (session.backend === "pty") {
    (session.process as PtyProcess).write(text);
  } else {
    (session.process as ChildProcessWithoutNullStreams).stdin.write(text);
  }

  return {
    success: true,
    sessionId,
    session_id: sessionId,
    message: `queued terminal text: ${text.slice(0, 50)}`,
  };
}

export function resizeTerminal(
  arg: string | { session_id?: string; sessionId?: string; cols?: number; rows?: number },
): TerminalActionResult {
  const sessionId =
    typeof arg === "string" ? arg : (arg.session_id ?? arg.sessionId);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    return {
      success: false,
      sessionId,
      session_id: sessionId,
      error: sessionId
        ? `Terminal session ${sessionId} not found.`
        : "sessionId is required for terminal resize.",
    };
  }

  const { cols, rows } = normalizeColsRows(typeof arg === "string" ? undefined : arg);
  session.cols = cols;
  session.rows = rows;
  if (session.backend === "pty") {
    (session.process as PtyProcess).resize(cols, rows);
  } else if (process.platform !== "win32") {
    (session.process as ChildProcessWithoutNullStreams).stdin.write(
      `stty cols ${cols} rows ${rows} 2>/dev/null || true\n`,
    );
  }

  return {
    success: true,
    sessionId,
    session_id: sessionId,
    cols,
    rows,
    backend: session.backend,
    message: `Terminal session ${sessionId} resized.`,
  };
}

export function clearTerminal(
  arg?: string | { session_id?: string; sessionId?: string },
): TerminalActionResult {
  const sessionId =
    typeof arg === "string" ? arg : (arg?.session_id ?? arg?.sessionId);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (session) {
    session.buffer = "";
    session.lastOutput = "";
  } else {
    lastOutputBuffer = "";
  }
  return {
    success: true,
    sessionId,
    session_id: sessionId,
    message: "Terminal cleared.",
  };
}

export function closeTerminal(
  arg?: string | { session_id?: string; sessionId?: string },
): TerminalActionResult {
  const sessionId =
    typeof arg === "string" ? arg : (arg?.session_id ?? arg?.sessionId);
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session?.process) {
      if (session.backend === "pty") {
        (session.process as PtyProcess).kill();
      } else {
        (session.process as ChildProcessWithoutNullStreams).kill();
      }
    }
    sessions.delete(sessionId);
  } else {
    for (const session of sessions.values()) {
      if (session.backend === "pty") {
        (session.process as PtyProcess).kill();
      } else {
        (session.process as ChildProcessWithoutNullStreams).kill();
      }
    }
    sessions.clear();
  }

  return {
    success: true,
    sessionId,
    session_id: sessionId,
    message: `Terminal session ${sessionId ?? "default"} closed.`,
  };
}

export function closeAllTerminalSessions(): void {
  closeTerminal();
}

export function listTerminalSessions(): TerminalSession[] {
  return Array.from(sessions.values()).map(({ process, ...session }) => session);
}

/** Alias of executeTerminal — upstream calls it execute_command. */
export const executeCommand = executeTerminal;
export const sendInputTerminal = typeTerminal;
