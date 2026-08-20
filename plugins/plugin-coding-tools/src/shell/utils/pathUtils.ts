/**
 * Path and command-safety guards: validatePath() confines a resolved path to the
 * allowed directory by realpath, while isForbiddenCommand/isSafeCommand/
 * extractBaseCommand gate which commands the shell will run (the
 * command-injection boundary). isSafeCommand still allows one data pipe
 * (`cat | grep`). It rejects active shell syntax outside quoted data and a
 * pipe into an interpreter or command dispatcher because ShellService then
 * runs the string as `shell -c`.
 *
 * Lexical `path.resolve` + `path.relative` is not enough for workdir/`cd`:
 * a symlink inside the allowed tree whose target is outside still looks
 * contained, and spawning with that cwd follows the link.
 */
import fs from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";
import { analyzeShellCommand } from "../approvals/analysis.js";

/** Resolve an existing directory without accepting partial or lexical paths. */
function resolveDirectoryRealPathSync(p: string): string | null {
  try {
    const realPath = fs.realpathSync(path.resolve(p));
    return fs.statSync(realPath).isDirectory() ? realPath : null;
  } catch {
    // error-policy:J3 cwd candidates are untrusted input. Missing, dangling,
    // looping, inaccessible, and racing paths all fail closed.
    return null;
  }
}

export function validatePath(
  commandPath: string,
  allowedDir: string,
  currentDir: string,
): string | null {
  const resolvedPath = path.resolve(currentDir, commandPath);
  const realPath = resolveDirectoryRealPathSync(resolvedPath);
  const realAllowed = resolveDirectoryRealPathSync(allowedDir);
  if (!realPath || !realAllowed) {
    logger.warn(
      `Path validation failed: ${resolvedPath} or its allowed directory could not be resolved as a directory`,
    );
    return null;
  }
  const relative = path.relative(realAllowed, realPath);

  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    logger.warn(
      `Path validation failed: ${resolvedPath} is outside allowed directory ${allowedDir}`,
    );
    return null;
  }

  return realPath;
}

const PIPE_INTERPRETERS = new Set([
  "bash",
  "cmd",
  "csh",
  "dash",
  "fish",
  "ksh",
  "node",
  "nodejs",
  "osascript",
  "perl",
  "powershell",
  "pwsh",
  "python",
  "python2",
  "python3",
  "ruby",
  "sh",
  "tcsh",
  "zsh",
]);

// These programs can dispatch the piped bytes to a later executable, so
// accepting them would make the interpreter check trivial to bypass (for
// example, `printf id | env sh`).
const PIPE_DISPATCHERS = new Set([
  "busybox",
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "setsid",
  "stdbuf",
  "sudo",
  "timeout",
  "xargs",
]);

function executableName(raw: string): string {
  return path.basename(raw.replace(/\\/g, "/")).toLowerCase();
}

export function isSafeCommand(command: string): boolean {
  const pathTraversalPatterns = [/\.\.\//g, /\.\.\\/g, /\/\.\./g, /\\\.\./g];

  for (const pattern of pathTraversalPatterns) {
    if (pattern.test(command)) {
      logger.warn(`Path traversal detected in command: ${command}`);
      return false;
    }
  }

  const analysis = analyzeShellCommand({ command });
  if (!analysis.ok || analysis.chains) {
    logger.warn(`Unsupported shell syntax detected in command: ${command}`);
    return false;
  }

  if (analysis.segments.length > 2) {
    logger.warn(`Multiple pipes detected in command: ${command}`);
    return false;
  }

  const pipeTarget = analysis.segments[1];
  if (pipeTarget) {
    const target = executableName(
      pipeTarget.resolution?.executableName ?? pipeTarget.argv[0] ?? "",
    );
    if (PIPE_INTERPRETERS.has(target) || PIPE_DISPATCHERS.has(target)) {
      logger.warn(`Unsafe pipe target detected in command: ${command}`);
      return false;
    }
  }

  return true;
}

export function extractBaseCommand(fullCommand: string): string {
  const parts = fullCommand.trim().split(/\s+/);
  return parts[0] || "";
}

export function isForbiddenCommand(
  command: string,
  forbiddenCommands: string[],
): boolean {
  const normalizedCommand = command.trim().toLowerCase();

  return forbiddenCommands.some((forbidden) => {
    const forbiddenLower = forbidden.toLowerCase();

    if (normalizedCommand.startsWith(forbiddenLower)) {
      return true;
    }

    if (!forbidden.includes(" ")) {
      const baseCommand = extractBaseCommand(command);
      if (baseCommand.toLowerCase() === forbiddenLower) {
        return true;
      }
    }

    return false;
  });
}
