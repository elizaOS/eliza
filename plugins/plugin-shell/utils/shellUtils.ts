/**
 * Shell Utilities - Platform-specific shell configuration and helpers
 * Ported from otto shell-utils.ts and bash-tools.shared.ts
 */

import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  resolveExecutable,
  resolveTerminalShell,
} from "./terminalCapabilities";

const CHUNK_LIMIT = 8 * 1024;

/**
 * Resolve PowerShell path on Windows
 */
function resolvePowerShellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (systemRoot) {
    const candidate = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "powershell.exe";
}

/**
 * Get shell configuration for the current platform
 */
export function getShellConfig(): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    // Use PowerShell instead of cmd.exe on Windows.
    // Many Windows system utilities write directly to the console via WriteConsole API,
    // bypassing stdout pipes. PowerShell properly captures and redirects their output.
    return {
      shell: resolvePowerShellPath(),
      args: ["-NoProfile", "-NonInteractive", "-Command"],
    };
  }

  const envShell = process.env.SHELL?.trim();
  const shellName = envShell ? path.basename(envShell) : "";
  // Fish rejects common bashisms used by tools, so prefer bash when detected.
  if (shellName === "fish") {
    const bash = resolveExecutable("bash");
    if (bash) {
      return { shell: bash, args: ["-c"] };
    }
    const sh = resolveExecutable("sh");
    if (sh) {
      return { shell: sh, args: ["-c"] };
    }
  }
  const resolved = resolveTerminalShell();
  return { shell: resolved.shell, args: resolved.args };
}

/**
 * Sanitize binary output by removing control characters
 */
export function sanitizeBinaryOutput(text: string): string {
  const scrubbed = text.replace(/[\p{Format}\p{Surrogate}]/gu, "");
  if (!scrubbed) {
    return scrubbed;
  }
  const chunks: string[] = [];
  for (const char of scrubbed) {
    const code = char.codePointAt(0);
    if (code == null) {
      continue;
    }
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      chunks.push(char);
      continue;
    }
    if (code < 0x20) {
      continue;
    }
    chunks.push(char);
  }
  return chunks.join("");
}

/**
 * Kill a process tree (cross-platform)
 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      // ignore errors if taskkill fails
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // process already dead
    }
  }
}

/**
 * Kill a session's process
 */
export function killSession(session: {
  pid?: number;
  child?: ChildProcessWithoutNullStreams;
}): void {
  const pid = session.pid ?? session.child?.pid;
  if (pid) {
    killProcessTree(pid);
  }
}

/**
 * Coerce environment object to Record<string, string>
 */
export function coerceEnv(
  env?: NodeJS.ProcessEnv | Record<string, string>
): Record<string, string> {
  const record: Record<string, string> = {};
  if (!env) {
    return record;
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      record[key] = value;
    }
  }
  return record;
}

/**
 * Resolve working directory with fallback
 */
export function resolveWorkdir(workdir: string, warnings: string[]): string {
  const current = safeCwd();
  const fallback = current ?? homedir();
  try {
    const stats = statSync(workdir);
    if (stats.isDirectory()) {
      return workdir;
    }
  } catch {
    // ignore, fallback below
  }
  warnings.push(`Warning: workdir "${workdir}" is unavailable; using "${fallback}".`);
  return fallback;
}

function safeCwd(): string | null {
  try {
    const cwd = process.cwd();
    return existsSync(cwd) ? cwd : null;
  } catch {
    return null;
  }
}

/**
 * Clamp a number to a range with a default value
 */
export function clampNumber(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (value === undefined || Number.isNaN(value)) {
    return defaultValue;
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * Read an environment variable as an integer
 */
export function readEnvInt(key: string): number | undefined {
  const raw = process.env[key];
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Chunk a string into smaller pieces
 */
export function chunkString(input: string, limit = CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < input.length; i += limit) {
    chunks.push(input.slice(i, i + limit));
  }
  return chunks;
}

/**
 * Safely slice a string respecting UTF-16 surrogate pairs
 */
export function sliceUtf16Safe(str: string, start: number, end?: number): string {
  const effectiveEnd = end ?? str.length;
  if (start < 0) {
    const adjustedStart = Math.max(0, str.length + start);
    return str.slice(adjustedStart, effectiveEnd);
  }
  return str.slice(start, effectiveEnd);
}

/**
 * Truncate string in the middle with ellipsis
 */
export function truncateMiddle(str: string, max: number): string {
  if (str.length <= max) {
    return str;
  }
  const half = Math.floor((max - 3) / 2);
  return `${sliceUtf16Safe(str, 0, half)}...${sliceUtf16Safe(str, -half)}`;
}

/**
 * Slice log lines with optional offset and limit
 */
export function sliceLogLines(
  text: string,
  offset?: number,
  limit?: number
): { slice: string; totalLines: number; totalChars: number } {
  if (!text) {
    return { slice: "", totalLines: 0, totalChars: 0 };
  }
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const totalLines = lines.length;
  const totalChars = text.length;
  let start =
    typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  if (limit !== undefined && offset === undefined) {
    const tailCount = Math.max(0, Math.floor(limit));
    start = Math.max(totalLines - tailCount, 0);
  }
  const end =
    typeof limit === "number" && Number.isFinite(limit)
      ? start + Math.max(0, Math.floor(limit))
      : undefined;
  return { slice: lines.slice(start, end).join("\n"), totalLines, totalChars };
}

/**
 * Derive a session name from a command
 */
export function deriveSessionName(command: string): string | undefined {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    return undefined;
  }
  const verb = tokens[0];
  let target = tokens.slice(1).find((t) => !t.startsWith("-"));
  if (!target) {
    target = tokens[1];
  }
  if (!target) {
    return verb;
  }
  const cleaned = truncateMiddle(stripQuotes(target), 48);
  return `${stripQuotes(verb)} ${cleaned}`;
}

function tokenizeCommand(command: string): string[] {
  const matches = command.match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g) ?? [];
  return matches.map((token) => stripQuotes(token)).filter(Boolean);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m${rem.toString().padStart(2, "0")}s`;
}

/**
 * Pad a string to a minimum width
 */
export function pad(str: string, width: number): string {
  if (str.length >= width) {
    return str;
  }
  return str + " ".repeat(width - str.length);
}

// ===== Spawn Utilities =====

export type SpawnFallback = {
  label: string;
  options: SpawnOptions;
};

export type SpawnWithFallbackResult = {
  child: ChildProcess;
  usedFallback: boolean;
  fallbackLabel?: string;
};

type SpawnWithFallbackParams = {
  argv: string[];
  options: SpawnOptions;
  fallbacks?: SpawnFallback[];
  spawnImpl?: typeof spawn;
  retryCodes?: string[];
  onFallback?: (err: unknown, fallback: SpawnFallback) => void;
};

const DEFAULT_RETRY_CODES = ["EBADF"];

/**
 * Format a spawn error for display
 */
export function formatSpawnError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const details = err as NodeJS.ErrnoException;
  const parts: string[] = [];
  const message = err.message?.trim();
  if (message) {
    parts.push(message);
  }
  if (details.code && !message?.includes(details.code)) {
    parts.push(details.code);
  }
  if (details.syscall) {
    parts.push(`syscall=${details.syscall}`);
  }
  if (typeof details.errno === "number") {
    parts.push(`errno=${details.errno}`);
  }
  return parts.join(" ");
}

function shouldRetry(err: unknown, codes: string[]): boolean {
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
  return code.length > 0 && codes.includes(code);
}

async function spawnAndWaitForSpawn(
  spawnImpl: typeof spawn,
  argv: string[],
  options: SpawnOptions
): Promise<ChildProcess> {
  const child = spawnImpl(argv[0], argv.slice(1), options);

  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("spawn", onSpawn);
    };
    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(child);
    };
    const onError = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    };
    const onSpawn = () => {
      finishResolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
    // Ensure mocked spawns that never emit "spawn" don't stall.
    process.nextTick(() => {
      if (typeof child.pid === "number") {
        finishResolve();
      }
    });
  });
}

/**
 * Spawn a process with fallback options on certain error codes
 */
export async function spawnWithFallback(
  params: SpawnWithFallbackParams
): Promise<SpawnWithFallbackResult> {
  const spawnImpl = params.spawnImpl ?? spawn;
  const retryCodes = params.retryCodes ?? DEFAULT_RETRY_CODES;
  const baseOptions = { ...params.options };
  const fallbacks = params.fallbacks ?? [];
  const attempts: Array<{ label?: string; options: SpawnOptions }> = [
    { options: baseOptions },
    ...fallbacks.map((fallback) => ({
      label: fallback.label,
      options: { ...baseOptions, ...fallback.options },
    })),
  ];

  let lastError: unknown;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      const child = await spawnAndWaitForSpawn(spawnImpl, params.argv, attempt.options);
      return {
        child,
        usedFallback: index > 0,
        fallbackLabel: attempt.label,
      };
    } catch (err) {
      lastError = err;
      const nextFallback = fallbacks[index];
      if (!nextFallback || !shouldRetry(err, retryCodes)) {
        throw err;
      }
      params.onFallback?.(err, nextFallback);
    }
  }

  throw lastError;
}
