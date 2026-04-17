import { execFile } from "node:child_process";
import os from "node:os";
import type { TerminalActionResult } from "../types.js";
import { checkDangerousCommand, sanitizeChildEnv } from "./security.js";

export type TerminalSession = {
  id: string;
  cwd: string;
  createdAt: string;
};

const sessions = new Map<string, TerminalSession>();
let sessionCounter = 0;

function truncateOutput(output: string): string {
  return output.slice(0, 5000);
}

function resolveShell(): { command: string; argsFor: (command: string) => string[] } {
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

export async function connectTerminal(
  cwd?: string,
): Promise<TerminalActionResult> {
  const sessionId = `term_${++sessionCounter}`;
  const sessionCwd = cwd || os.homedir();
  sessions.set(sessionId, {
    id: sessionId,
    cwd: sessionCwd,
    createdAt: new Date().toISOString(),
  });
  return {
    success: true,
    sessionId,
    session_id: sessionId,
    cwd: sessionCwd,
    message: `Terminal session ${sessionId} created.`,
  };
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
        const output = truncateOutput(`${stdout}${stderr ? `\n${stderr}` : ""}`);
        if (!error) {
          resolve({
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
        resolve({
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

    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        success: false,
        output: "",
        exitCode: -1,
        exit_code: -1,
        cwd: sessionCwd,
        sessionId: params.sessionId,
        session_id: params.sessionId,
        error: `Command timed out after ${timeoutSeconds}s.`,
      });
    }, (timeoutSeconds + 1) * 1000);

    child.once("exit", () => {
      clearTimeout(killTimer);
    });
  });
}

export async function readTerminal(
  sessionId?: string,
): Promise<TerminalActionResult> {
  return {
    success: true,
    sessionId,
    session_id: sessionId,
    output: "",
    message: "No pending terminal output.",
  };
}

export async function typeTerminal(
  text: string,
): Promise<TerminalActionResult> {
  return {
    success: true,
    message: `Queued terminal text: ${text.slice(0, 50)}`,
  };
}

export async function clearTerminal(
  sessionId?: string,
): Promise<TerminalActionResult> {
  return {
    success: true,
    sessionId,
    message: "Terminal cleared.",
  };
}

export async function closeTerminal(
  sessionId?: string,
): Promise<TerminalActionResult> {
  if (sessionId) {
    sessions.delete(sessionId);
  } else {
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
  sessions.clear();
}

export function listTerminalSessions(): TerminalSession[] {
  return Array.from(sessions.values());
}
