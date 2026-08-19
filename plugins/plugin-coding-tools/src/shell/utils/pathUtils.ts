/**
 * Path and command-safety guards: validatePath() confines a resolved path to the
 * allowed directory, while isForbiddenCommand/isSafeCommand/extractBaseCommand
 * gate which commands the shell will run (the command-injection boundary).
 * isSafeCommand still allows one data pipe (cat | grep). It rejects active
 * shell syntax outside quoted data and a pipe into an interpreter or command
 * dispatcher because ShellService then runs the string as `shell -c`.
 */
import * as fs from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";
import { analyzeShellCommand } from "../approvals/analysis.js";

function resolveRealPathSync(p: string): string {
  const absolute = path.resolve(p);
  try {
    return fs.realpathSync(absolute);
  } catch {
    // error-policy:J3 leaf or ancestor missing — walk up to longest existing
    // prefix and realpath that, then rejoin the tail so a workspace
    // directory symlink to an outside folder cannot hide behind a
    // not-yet-created basename.
  }
  const tail: string[] = [];
  let current = absolute;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    tail.unshift(path.basename(current));
    try {
      return path.join(fs.realpathSync(parent), ...tail);
    } catch {
      current = parent;
    }
  }
}

export function validatePath(
  commandPath: string,
  allowedDir: string,
  currentDir: string,
): string | null {
  const resolvedPath = path.resolve(currentDir, commandPath);
  const normalizedPath = path.normalize(resolvedPath);
  const normalizedAllowed = path.normalize(allowedDir);

  // Physical containment: resolve symlinks through the longest existing
  // ancestor so a workspace dir symlink to an outside folder cannot bypass
  // the lexical `path.relative` check (a -> /etc, a/b lexically passes but
  // physically is outside).
  const realPath = resolveRealPathSync(resolvedPath);
  const realAllowed = resolveRealPathSync(normalizedAllowed);
  const realRelative = path.relative(realAllowed, realPath);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    logger.warn(
      `Path validation failed: ${normalizedPath} is outside allowed directory ${normalizedAllowed}`,
    );
    return null;
  }

  return normalizedPath;
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
