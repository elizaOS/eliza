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

// Canonicalize a command the same way the shell executor tokenizes it before
// the blocklist compares it. Two shell behaviours are folded in:
//   1. A backslash immediately before a newline is a line continuation that
//      `bash -c` removes entirely before tokenization, so `rm \<newline>-rf /`
//      reaches the same argv as `rm -rf /`. Strip these first, otherwise the
//      stray backslash survives whitespace collapse and defeats the match.
//   2. Runs of any remaining whitespace (spaces, tabs, newlines) collapse to a
//      single space and lowercase, because `bash -c` collapses inter-token
//      whitespace and runCommandSimple splits on /\s+/.
// Without this normalization a prefix comparison on the raw string lets
// `rm  -rf  /`, `rm\t-rf /`, or a line-continuation spelling slip past a
// `rm -rf /` entry that the shell would still run destructively.
function collapseWhitespace(value: string): string {
  return value
    .replace(/\\\r?\n/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function isForbiddenCommand(
  command: string,
  forbiddenCommands: string[],
): boolean {
  const normalizedCommand = collapseWhitespace(command);

  return forbiddenCommands.some((forbidden) => {
    const forbiddenNormalized = collapseWhitespace(forbidden);
    if (forbiddenNormalized === "") {
      return false;
    }

    if (normalizedCommand.startsWith(forbiddenNormalized)) {
      return true;
    }

    if (!forbiddenNormalized.includes(" ")) {
      const baseCommand = extractBaseCommand(normalizedCommand);
      if (baseCommand === forbiddenNormalized) {
        return true;
      }
    }

    return false;
  });
}
