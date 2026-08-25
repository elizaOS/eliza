/**
 * FILE `glob` handler: expands a glob pattern to matching file paths, rooted at an
 * explicit path or the conversation's SessionCwdService cwd, with SandboxService
 * validation on the search root and every returned candidate.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger as coreLogger } from "@elizaos/core";

import {
  failureToActionResult,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import { resolveInputPath } from "../lib/path-utils.js";
import type { SandboxService } from "../services/sandbox-service.js";
import type { SessionCwdService } from "../services/session-cwd-service.js";
import {
  CODING_TOOLS_LOG_PREFIX,
  SANDBOX_SERVICE,
  SESSION_CWD_SERVICE,
} from "../types.js";

const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".turbo",
  ".cache",
]);

function unsafeGlobPattern(pattern: string): string | undefined {
  if (pattern.includes("\0")) return "glob pattern must not contain NUL";
  if (
    path.isAbsolute(pattern) ||
    pattern.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(pattern)
  ) {
    return "glob pattern must be relative to the validated search root";
  }
  if (/(?:^|[\\/,{])\.\.(?=$|[\\/,}])/.test(pattern)) {
    return "glob pattern must not traverse above the validated search root";
  }
  return undefined;
}

/** Exported for focused compatibility tests of the minimal legacy matcher. */
export function globToRegExp(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const after = pattern[i + 2];
        if (after === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        regex += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i += 1;
    } else if (ch === ".") {
      regex += "\\.";
      i += 1;
    } else if ("+^$()|[]{}\\".includes(ch ?? "")) {
      regex += `\\${ch}`;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }
  return new RegExp(`^${regex}$`);
}

type ReadDirectory = (
  directory: string,
) => Promise<Array<import("node:fs").Dirent>>;

const readDirectoryWithTypes: ReadDirectory = (directory) =>
  fs.readdir(directory, { withFileTypes: true });

/**
 * Discover only entries physically reachable beneath `root`, without following
 * directory symlinks, then apply glob syntax to root-relative candidate names.
 * Pattern text never reaches a filesystem traversal API.
 */
export async function walkContainedGlob(
  root: string,
  pattern: string,
  readDirectory: ReadDirectory = readDirectoryWithTypes,
): Promise<string[]> {
  const results: string[] = [];
  const canMatchDescendants = /[\\/]/.test(pattern);

  async function walk(dir: string): Promise<void> {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await readDirectory(dir);
    } catch {
      // error-policy:J6 best-effort walk; a directory that became unreadable
      // (permissions, race) is skipped so the remaining tree is still globbed.
      return;
    }
    for (const entry of entries) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (canMatchDescendants) await walk(abs);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (path.matchesGlob(rel, pattern)) {
        results.push(abs);
      }
    }
  }

  await walk(root);
  return results;
}

export async function globHandler(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  options: unknown,
  // Read-only query: deliberately no visible callback. Raw listings/matches
  // reach the model via the ActionResult and the user via the planner's final
  // message; posting each mid-turn dump spammed chat channels (one message per
  // exploratory call).
  _callback?: HandlerCallback,
): Promise<ActionResult> {
  const conversationId =
    message.roomId !== undefined && message.roomId !== null
      ? String(message.roomId)
      : undefined;
  if (!conversationId) {
    return failureToActionResult({
      reason: "missing_param",
      message: "no roomId",
    });
  }

  const pattern = readStringParam(options, "pattern");
  if (!pattern || pattern.length === 0) {
    return failureToActionResult({
      reason: "missing_param",
      message: "pattern is required",
    });
  }
  const patternFailure = unsafeGlobPattern(pattern);
  if (patternFailure) {
    return failureToActionResult({
      reason: "invalid_param",
      message: patternFailure,
    });
  }

  const sandbox = runtime.getService(SANDBOX_SERVICE) as InstanceType<
    typeof SandboxService
  > | null;
  const session = runtime.getService(SESSION_CWD_SERVICE) as InstanceType<
    typeof SessionCwdService
  > | null;
  if (!sandbox || !session) {
    return failureToActionResult({
      reason: "internal",
      message: "coding-tools services unavailable",
    });
  }

  const requestedPath = readStringParam(options, "path");
  let targetPath: string;
  if (requestedPath === undefined) {
    targetPath = (await session.getExistingCwd(conversationId)).cwd;
  } else {
    const input = resolveInputPath(runtime, conversationId, requestedPath);
    if (!input.ok) return failureToActionResult(input.failure);
    targetPath = input.value;
  }

  const validation = await sandbox.validatePath(conversationId, targetPath);
  if (validation.ok === false) {
    const reason =
      validation.reason === "blocked" ? "path_blocked" : "invalid_param";
    return failureToActionResult({ reason, message: validation.message });
  }
  const root = validation.resolved;

  let candidates: string[];
  try {
    candidates = await walkContainedGlob(root, pattern);
  } catch (error) {
    return failureToActionResult({
      reason: "invalid_param",
      message: `invalid glob pattern: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const validatedCandidates: string[] = [];
  for (const filePath of candidates) {
    const candidateValidation = await sandbox.validatePath(
      conversationId,
      filePath,
    );
    if (candidateValidation.ok === false) {
      const reason =
        candidateValidation.reason === "blocked"
          ? "path_blocked"
          : "invalid_param";
      return failureToActionResult({
        reason,
        message: `glob candidate rejected: ${candidateValidation.message}`,
      });
    }
    validatedCandidates.push(filePath);
  }

  const stats = await Promise.all(
    validatedCandidates.map(async (filePath) => {
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) return undefined;
        return { filePath, mtimeMs: stat.mtimeMs };
      } catch {
        // error-policy:J6 best-effort mtime enrichment; a candidate that
        // vanished between glob and stat drops out of the sorted result.
        return undefined;
      }
    }),
  );

  const filtered = stats.filter(
    (entry): entry is { filePath: string; mtimeMs: number } =>
      entry !== undefined,
  );
  filtered.sort((a, b) => {
    const bMtime =
      typeof b.mtimeMs === "number" && Number.isFinite(b.mtimeMs)
        ? b.mtimeMs
        : 0;
    const aMtime =
      typeof a.mtimeMs === "number" && Number.isFinite(a.mtimeMs)
        ? a.mtimeMs
        : 0;
    return bMtime - aMtime || a.filePath.localeCompare(b.filePath);
  });

  const files = filtered.map((entry) => entry.filePath);

  const header = `${files.length} files`;
  const text = files.length === 0 ? header : `${header}\n${files.join("\n")}`;

  coreLogger.debug(
    `${CODING_TOOLS_LOG_PREFIX} GLOB pattern=${JSON.stringify(pattern)} root=${root} found=${files.length}`,
  );

  return successActionResult(text, {
    files,
    truncated: false,
  });
}
