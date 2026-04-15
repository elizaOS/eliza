import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { resolve } from "node:path";
import { validateText } from "./helpers.js";

interface TerminalSession {
  id: string;
  cwd: string;
  pendingInput: string;
  lastCommand: string;
  lastOutput: string;
  lastExitCode: number | null;
}

interface TerminalResult {
  success: boolean;
  session_id: string;
  cwd: string;
  output?: string;
  message?: string;
  error?: string;
  exit_code?: number;
}

const sessions = new Map<string, TerminalSession>();
const DEFAULT_SESSION_ID = "default";
let sessionCounter = 0;
let activeSessionId: string | null = null;

const STRIP_EXACT_ENV = new Set([
  "INTERNAL_API_KEY",
  "CSRF_SECRET",
  "ENCRYPTION_KEY",
  "SUPABASE_SERVICE_ROLE",
  "STRIPE_API_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "POSTHOG_API_KEY",
]);

const STRIP_PATTERN_ENV: RegExp[] = [
  /^SUPABASE_.*(?:SERVICE_ROLE|SECRET)/i,
  /^STRIPE_.*(?:SECRET|WEBHOOK)/i,
  /^COASTY_.*(?:SECRET|KEY|TOKEN)/i,
];

const DANGEROUS_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[^\n;|&]*r[^\n;|&]*\s+\/(\s*$|\s*;|\s*&|\s*\|)/mi, reason: "Recursive deletion of the root filesystem (rm -rf /)." },
  { pattern: /\brm\s+-[^\n;|&]*r[^\n;|&]*\s+\/\*/mi, reason: "Recursive deletion of all root contents (rm -rf /*)." },
  { pattern: /\brm\s+-[^\n;|&]*r[^\n;|&]*\s+~\/?(\s|$|;|&|\|)/mi, reason: "Recursive deletion of the entire home directory." },
  { pattern: /\brd\s+\/s\s+(?:\/q\s+)?[A-Z]:\\?\s*$/im, reason: "Recursive deletion of an entire drive (rd /s /q C:\\)." },
  { pattern: /\brmdir\s+\/s\s+(?:\/q\s+)?[A-Z]:\\?\s*$/im, reason: "Recursive deletion of an entire drive (rmdir /s /q C:\\)." },
  { pattern: /\bdel\s+.*\/[sS].*[A-Z]:\\/im, reason: "Mass deletion from drive root (del /s C:\\)." },
  { pattern: /\bRemove-Item\b(?=[^;|&]*-Recurse)(?=[^;|&]*[\s'"][A-Z]:[\\\/](?=[^a-zA-Z0-9]|$))/im, reason: "PowerShell recursive deletion of drive root (Remove-Item -Recurse C:\\)." },
  { pattern: /\bRemove-Item\b(?=[^;|&]*-Recurse)(?=[^;|&]*[\s'"]\/{1,2}['"\s])/im, reason: "PowerShell recursive deletion of filesystem root." },
  { pattern: /\bFormat-Volume\b/im, reason: "PowerShell disk format command (Format-Volume)." },
  { pattern: /\bClear-Disk\b/im, reason: "PowerShell disk clearing command (Clear-Disk)." },
  { pattern: /\b(?:powershell|pwsh)(?:\.exe)?\b[^|]*-(?:enc|encodedcommand)\b/im, reason: "Encoded PowerShell command." },
  { pattern: /\bformat\s+[A-Z]:/im, reason: "Disk format command (format C:)." },
  { pattern: /\bmkfs(?:\.\w+)?\s/, reason: "Filesystem format command (mkfs)." },
  { pattern: /\bdd\s+[^;|&]*\bof=\/dev\/[hs]d/i, reason: "Raw disk write (dd of=/dev/sdX)." },
  { pattern: /\bdd\s+[^;|&]*\bof=\\\\\.\\PhysicalDrive/i, reason: "Raw disk write to Windows physical drive." },
  { pattern: /:\(\)\s*\{[^}]*:\s*\|\s*:/, reason: "Fork bomb detected." },
  { pattern: /%0\s*\|\s*%0/, reason: "Windows fork bomb detected (%0|%0)." },
  { pattern: /\bchmod\s+(-\w+\s+)*\d{3,4}\s+\/(\s*$|\s*;)/m, reason: "Recursive permission change on root filesystem." },
  { pattern: /\bchown\s+(-\w+\s+)*\S+:\S*\s+\/(\s*$|\s*;)/m, reason: "Recursive ownership change on root filesystem." },
  { pattern: /\breg\s+delete\s+HKLM\\/i, reason: "System registry deletion (HKLM)." },
  { pattern: /\breg\s+delete\s+HKEY_LOCAL_MACHINE\\/i, reason: "System registry deletion (HKEY_LOCAL_MACHINE)." },
  { pattern: /\bbootrec\s+\/fixmbr/i, reason: "Boot record modification (bootrec)." },
  { pattern: /\bbcdboot\b.*\/[sf]\s/i, reason: "Boot configuration modification." },
];

function sanitizeChildEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (STRIP_EXACT_ENV.has(key)) {
      delete env[key];
      continue;
    }
    for (const pattern of STRIP_PATTERN_ENV) {
      if (pattern.test(key)) {
        delete env[key];
        break;
      }
    }
  }
  return env;
}

function checkDangerousCommand(command: string): { blocked: boolean; reason?: string } {
  if (!command || typeof command !== "string") {
    return { blocked: false };
  }

  const trimmed = command.trim();
  for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        blocked: true,
        reason: `Command blocked: ${reason}\nIf you genuinely need to run this, execute it manually in a terminal.`,
      };
    }
  }

  return { blocked: false };
}

function createSession(cwd = homedir()): TerminalSession {
  const session: TerminalSession = {
    id: `term_${++sessionCounter}`,
    cwd: resolve(cwd),
    pendingInput: "",
    lastCommand: "",
    lastOutput: "",
    lastExitCode: null,
  };
  sessions.set(session.id, session);
  activeSessionId = session.id;
  return session;
}

function getDefaultSession(): TerminalSession {
  if (activeSessionId && sessions.has(activeSessionId)) {
    return sessions.get(activeSessionId)!;
  }

  const existing = sessions.get(DEFAULT_SESSION_ID);
  if (existing) {
    activeSessionId = DEFAULT_SESSION_ID;
    return existing;
  }

  const session: TerminalSession = {
    id: DEFAULT_SESSION_ID,
    cwd: homedir(),
    pendingInput: "",
    lastCommand: "",
    lastOutput: "",
    lastExitCode: null,
  };
  sessions.set(DEFAULT_SESSION_ID, session);
  activeSessionId = DEFAULT_SESSION_ID;
  return session;
}

function resolveSession(sessionId?: string): TerminalSession | undefined {
  if (sessionId) {
    return sessions.get(sessionId);
  }
  return getDefaultSession();
}

function parseTimeout(timeout?: number): number {
  if (timeout === undefined || timeout === null) {
    return 30;
  }
  const parsed = Number(timeout);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 30;
  }
  return Math.max(1, Math.round(parsed));
}

function trimOutput(output: string): string {
  return output.slice(0, 5000);
}

function runTerminalCommand(command: string, cwd: string, timeoutSeconds: number): Promise<{ success: boolean; output: string; exit_code: number; error?: string }> {
  return new Promise((resolveResult) => {
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
    const args = process.platform === "win32"
      ? ["-NoProfile", "-Command", command]
      : ["-lc", command];

    execFile(
      shell,
      args,
      {
        cwd,
        timeout: timeoutSeconds * 1000,
        maxBuffer: 1024 * 1024,
        env: sanitizeChildEnv(),
      },
      (error, stdout, stderr) => {
        const output = trimOutput(String(stdout ?? "") + (stderr ? `\n${stderr}` : ""));
        if (error) {
          resolveResult({
            success: false,
            output,
            exit_code: typeof error.code === "number" ? error.code : -1,
            error: error.message,
          });
          return;
        }

        resolveResult({
          success: true,
          output,
          exit_code: 0,
        });
      },
    );
  });
}

export function connectTerminal(params: { cwd?: string } = {}): TerminalResult {
  const cwd = params.cwd ? resolve(params.cwd) : homedir();
  const session = createSession(cwd);
  return {
    success: true,
    session_id: session.id,
    cwd: session.cwd,
    message: `Terminal session ${session.id} created`,
  };
}

export async function executeTerminal(params: {
  command: string;
  timeout?: number;
  session_id?: string;
}): Promise<TerminalResult> {
  if (!params.command || typeof params.command !== "string") {
    return {
      success: false,
      session_id: params.session_id ?? DEFAULT_SESSION_ID,
      cwd: resolveSession(params.session_id)?.cwd ?? homedir(),
      output: "",
      error: "No command provided",
      exit_code: -1,
    };
  }

  const risk = checkDangerousCommand(params.command);
  if (risk.blocked) {
    const session = resolveSession(params.session_id) ?? getDefaultSession();
    session.lastCommand = params.command;
    session.lastOutput = "";
    session.lastExitCode = -1;
    return {
      success: false,
      session_id: session.id,
      cwd: session.cwd,
      output: "",
      error: risk.reason,
      exit_code: -1,
    };
  }

  const session = resolveSession(params.session_id) ?? (params.session_id ? undefined : getDefaultSession());
  if (!session) {
    return {
      success: false,
      session_id: params.session_id ?? DEFAULT_SESSION_ID,
      cwd: homedir(),
      output: "",
      error: `Terminal session ${params.session_id} not found`,
      exit_code: -1,
    };
  }

  const timeoutSeconds = parseTimeout(params.timeout);
  const result = await runTerminalCommand(params.command, session.cwd, timeoutSeconds);
  session.lastCommand = params.command;
  session.lastOutput = result.output;
  session.lastExitCode = result.exit_code;
  session.pendingInput = "";

  return {
    success: result.success,
    session_id: session.id,
    cwd: session.cwd,
    output: result.output,
    error: result.error,
    exit_code: result.exit_code,
  };
}

export function readTerminal(params: { session_id?: string } = {}): TerminalResult {
  const session = resolveSession(params.session_id);
  if (!session) {
    return {
      success: false,
      session_id: params.session_id ?? DEFAULT_SESSION_ID,
      cwd: homedir(),
      output: "",
      error: `Terminal session ${params.session_id} not found`,
      exit_code: -1,
    };
  }

  return {
    success: true,
    session_id: session.id,
    cwd: session.cwd,
    output: session.lastOutput,
    message: session.lastOutput ? "Latest terminal output" : "No pending output",
    exit_code: session.lastExitCode ?? 0,
  };
}

export function typeTerminal(params: { text: string; session_id?: string }): TerminalResult {
  const session = resolveSession(params.session_id) ?? (params.session_id ? undefined : getDefaultSession());
  if (!session) {
    return {
      success: false,
      session_id: params.session_id ?? DEFAULT_SESSION_ID,
      cwd: homedir(),
      output: "",
      error: `Terminal session ${params.session_id} not found`,
      exit_code: -1,
    };
  }

  const text = validateText(params.text);
  session.pendingInput += text;

  return {
    success: true,
    session_id: session.id,
    cwd: session.cwd,
    message: `Text "${text.slice(0, 50)}" queued for the terminal`,
  };
}

export function clearTerminal(params: { session_id?: string } = {}): TerminalResult {
  const session = resolveSession(params.session_id);
  if (!session) {
    return {
      success: false,
      session_id: params.session_id ?? DEFAULT_SESSION_ID,
      cwd: homedir(),
      output: "",
      error: `Terminal session ${params.session_id} not found`,
      exit_code: -1,
    };
  }

  session.pendingInput = "";
  session.lastCommand = "";
  session.lastOutput = "";
  session.lastExitCode = null;

  return {
    success: true,
    session_id: session.id,
    cwd: session.cwd,
    message: "Terminal cleared",
  };
}

export function closeTerminal(params: { session_id?: string } = {}): TerminalResult {
  const session = resolveSession(params.session_id);
  if (session) {
    sessions.delete(session.id);
    if (activeSessionId === session.id) {
      activeSessionId = sessions.has(DEFAULT_SESSION_ID) ? DEFAULT_SESSION_ID : null;
    }
  }

  return {
    success: true,
    session_id: session?.id ?? params.session_id ?? DEFAULT_SESSION_ID,
    cwd: session?.cwd ?? homedir(),
    message: `Terminal session ${session?.id ?? params.session_id ?? DEFAULT_SESSION_ID} closed`,
  };
}

export const executeCommand = executeTerminal;
