import { type SpawnOptions, spawn } from "node:child_process";
import { DEFAULT_ZCA_TIMEOUT, ZCA_BINARY } from "./constants";
import type {
  ZaloFriend,
  ZaloGroup,
  ZaloUserInfo,
  ZaloUserProfile,
} from "./types";

/**
 * Options for running ZCA commands.
 */
export interface ZcaRunOptions {
  /** Profile to use */
  profile?: string;
  /** Working directory */
  cwd?: string;
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Result from a ZCA command execution.
 */
export interface ZcaResult {
  /** Whether the command succeeded */
  ok: boolean;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Exit code */
  exitCode: number;
}

/**
 * Build command line arguments with profile flag.
 */
function buildArgs(args: string[], options?: ZcaRunOptions): string[] {
  const result: string[] = [];
  // Profile flag comes first (before subcommand)
  const profile = options?.profile || process.env.ZCA_PROFILE;
  if (profile) {
    result.push("--profile", profile);
  }
  result.push(...args);
  return result;
}

/**
 * Run a ZCA CLI command.
 */
export async function runZca(
  args: string[],
  options?: ZcaRunOptions,
): Promise<ZcaResult> {
  const fullArgs = buildArgs(args, options);
  const timeout = options?.timeout ?? DEFAULT_ZCA_TIMEOUT;

  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      cwd: options?.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    };

    const proc = spawn(ZCA_BINARY, fullArgs, spawnOpts);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeout);

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          stdout,
          stderr: stderr || "Command timed out",
          exitCode: code ?? 124,
        });
        return;
      }
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout: "",
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}

/**
 * Run a ZCA command with interactive stdio (for QR login).
 */
export function runZcaInteractive(
  args: string[],
  options?: ZcaRunOptions,
): Promise<ZcaResult> {
  const fullArgs = buildArgs(args, options);

  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      cwd: options?.cwd,
      env: { ...process.env },
      stdio: "inherit",
    };

    const proc = spawn(ZCA_BINARY, fullArgs, spawnOpts);

    proc.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout: "",
        stderr: "",
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
      resolve({
        ok: false,
        stdout: "",
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Parse JSON from ZCA command output, handling ANSI codes and prefixed log lines.
 */
export function parseJsonOutput<T>(stdout: string): T | null {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    const cleaned = stripAnsi(stdout);

    try {
      return JSON.parse(cleaned) as T;
    } catch {
      // zca may prefix output with INFO/log lines, try to find JSON
      const lines = cleaned.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("{") || line.startsWith("[")) {
          // Try parsing from this line to the end
          const jsonCandidate = lines.slice(i).join("\n").trim();
          try {
            return JSON.parse(jsonCandidate) as T;
          } catch {}
        }
      }
      return null;
    }
  }
}

/**
 * Check if zca-cli is installed and available.
 */
export async function checkZcaInstalled(): Promise<boolean> {
  const result = await runZca(["--version"], { timeout: 5000 });
  return result.ok;
}

/**
 * Check if authenticated for a given profile.
 */
export async function checkZcaAuthenticated(
  profile?: string,
): Promise<boolean> {
  const result = await runZca(["auth", "status"], {
    profile,
    timeout: 5000,
  });
  return result.ok;
}

/**
 * Get the authenticated user info.
 */
export async function getZcaUserInfo(
  profile?: string,
): Promise<ZaloUserInfo | null> {
  const result = await runZca(["me", "info", "-j"], {
    profile,
    timeout: 10000,
  });
  if (!result.ok) {
    return null;
  }
  return parseJsonOutput<ZaloUserInfo>(result.stdout);
}

/**
 * List available profiles.
 */
export async function listZcaProfiles(): Promise<ZaloUserProfile[]> {
  const result = await runZca(["profile", "list", "-j"], { timeout: 5000 });
  if (!result.ok) {
    return [];
  }
  return parseJsonOutput<ZaloUserProfile[]>(result.stdout) ?? [];
}

/**
 * List friends.
 */
export async function listFriends(
  profile?: string,
  query?: string,
): Promise<ZaloFriend[]> {
  const args = query?.trim()
    ? ["friend", "find", query.trim()]
    : ["friend", "list", "-j"];
  const result = await runZca(args, { profile, timeout: 15000 });
  if (!result.ok) {
    return [];
  }
  return parseJsonOutput<ZaloFriend[]>(result.stdout) ?? [];
}

/**
 * List groups.
 */
export async function listGroups(profile?: string): Promise<ZaloGroup[]> {
  const result = await runZca(["group", "list", "-j"], {
    profile,
    timeout: 15000,
  });
  if (!result.ok) {
    return [];
  }
  return parseJsonOutput<ZaloGroup[]>(result.stdout) ?? [];
}

/**
 * List group members.
 */
export async function listGroupMembers(
  groupId: string,
  profile?: string,
): Promise<ZaloFriend[]> {
  const result = await runZca(["group", "members", groupId, "-j"], {
    profile,
    timeout: 15000,
  });
  if (!result.ok) {
    return [];
  }
  return parseJsonOutput<ZaloFriend[]>(result.stdout) ?? [];
}

/**
 * Send a text message.
 */
export async function sendMessage(
  threadId: string,
  text: string,
  options: { profile?: string; isGroup?: boolean } = {},
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (!threadId?.trim()) {
    return { ok: false, error: "No threadId provided" };
  }

  const args = ["msg", "send", threadId.trim(), text.slice(0, 2000)];
  if (options.isGroup) {
    args.push("-g");
  }

  const result = await runZca(args, { profile: options.profile });

  if (result.ok) {
    // Try to extract message ID from output
    const messageId = extractMessageId(result.stdout);
    return { ok: true, messageId };
  }

  return { ok: false, error: result.stderr || "Failed to send message" };
}

/**
 * Send an image message.
 */
export async function sendImage(
  threadId: string,
  imageUrl: string,
  options: { profile?: string; caption?: string; isGroup?: boolean } = {},
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const args = ["msg", "image", threadId.trim(), "-u", imageUrl.trim()];
  if (options.caption) {
    args.push("-m", options.caption.slice(0, 2000));
  }
  if (options.isGroup) {
    args.push("-g");
  }

  const result = await runZca(args, { profile: options.profile });

  if (result.ok) {
    return { ok: true, messageId: extractMessageId(result.stdout) };
  }
  return { ok: false, error: result.stderr || "Failed to send image" };
}

/**
 * Send a link message.
 */
export async function sendLink(
  threadId: string,
  url: string,
  options: { profile?: string; isGroup?: boolean } = {},
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const args = ["msg", "link", threadId.trim(), url.trim()];
  if (options.isGroup) {
    args.push("-g");
  }

  const result = await runZca(args, { profile: options.profile });

  if (result.ok) {
    return { ok: true, messageId: extractMessageId(result.stdout) };
  }
  return { ok: false, error: result.stderr || "Failed to send link" };
}

/**
 * Extract message ID from ZCA output.
 */
function extractMessageId(stdout: string): string | undefined {
  // Try to extract message ID from output
  const match = stdout.match(/message[_\s]?id[:\s]+(\S+)/i);
  if (match) {
    return match[1];
  }
  // Return first word if it looks like an ID
  const firstWord = stdout.trim().split(/\s+/)[0];
  if (firstWord && /^[a-zA-Z0-9_-]+$/.test(firstWord)) {
    return firstWord;
  }
  return undefined;
}

/**
 * Streaming options for ZCA commands.
 */
export interface ZcaStreamingOptions extends ZcaRunOptions {
  onData?: (data: string) => void;
  onError?: (err: Error) => void;
}

/**
 * Run a ZCA command with streaming output.
 */
export function runZcaStreaming(
  args: string[],
  options?: ZcaStreamingOptions,
): { proc: ReturnType<typeof spawn>; promise: Promise<ZcaResult> } {
  const fullArgs = buildArgs(args, options);

  const spawnOpts: SpawnOptions = {
    cwd: options?.cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  };

  const proc = spawn(ZCA_BINARY, fullArgs, spawnOpts);
  let stdout = "";
  let stderr = "";

  proc.stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    stdout += text;
    options?.onData?.(text);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  const promise = new Promise<ZcaResult>((resolve) => {
    proc.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
      options?.onError?.(err);
      resolve({
        ok: false,
        stdout: "",
        stderr: err.message,
        exitCode: 1,
      });
    });
  });

  return { proc, promise };
}
