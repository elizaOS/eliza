/**
 * Path predicates and resolution used by the sandbox policy and file handlers.
 * Relative FILE inputs resolve through the conversation's session cwd, while
 * device and `/proc/<pid>/fd` pseudo-paths remain blocked.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IAgentRuntime, Service } from "@elizaos/core";
import type { SessionCwdService } from "../services/session-cwd-service.js";
import {
  failure,
  SESSION_CWD_SERVICE,
  success,
  type ToolResult,
} from "../types.js";

const BLOCKED_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
]);

const BLOCKED_PROC_FD = /^\/proc\/\d+\/fd\//;

type SessionCwdReader = Service & Pick<SessionCwdService, "getCwd">;

function isSessionCwdReader(
  service: Service | null,
): service is SessionCwdReader {
  return (
    service !== null && typeof Reflect.get(service, "getCwd") === "function"
  );
}

export function isAbsolutePath(p: string): boolean {
  if (!p || typeof p !== "string") return false;
  if (p.startsWith("\\\\") || p.startsWith("//")) return false;
  return path.isAbsolute(p);
}

export function isBlockedPath(p: string): boolean {
  if (BLOCKED_PATHS.has(p)) return true;
  if (BLOCKED_PROC_FD.test(p)) return true;
  return false;
}

export function normalizeAbsolute(p: string): string {
  return path.resolve(p);
}

export async function resolveRealPath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    // error-policy:J3 realpath requires the path to exist on disk; for a
    // not-yet-created target the lexical resolve is the designed fallback the
    // sandbox root check relies on (symlinks simply resolve to themselves).
    return path.resolve(p);
  }
}

export function isWithin(child: string, parent: string): boolean {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  if (resolvedChild === resolvedParent) return true;
  const rel = path.relative(resolvedParent, resolvedChild);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function isWithinAnyRoot(
  p: string,
  roots: string[],
): Promise<boolean> {
  if (roots.length === 0) return false;
  const real = await resolveRealPath(p);
  for (const root of roots) {
    const rootReal = await resolveRealPath(root);
    if (isWithin(real, rootReal)) return true;
  }
  return false;
}

export function isUncPath(p: string): boolean {
  return p.startsWith("\\\\") || p.startsWith("//");
}

export function relativeFromRoot(p: string, root: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === "" ? "." : rel;
}

/**
 * Resolves a FILE handler path against the conversation's working directory.
 * Relative paths require SessionCwdService so a missing plugin service cannot
 * silently redirect filesystem work to the process working directory.
 */
export function resolveInputPath(
  runtime: IAgentRuntime,
  conversationId: string,
  filePath: string,
): ToolResult<string> {
  if (isUncPath(filePath)) {
    return failure("invalid_param", "UNC paths are not supported");
  }
  if (isAbsolutePath(filePath)) return success(filePath);

  const cwdService = runtime.getService<Service>(SESSION_CWD_SERVICE);
  if (!isSessionCwdReader(cwdService)) {
    return failure(
      "internal",
      "SessionCwdService unavailable; cannot resolve relative file_path",
    );
  }

  const cwd = cwdService.getCwd(conversationId);
  if (!isAbsolutePath(cwd)) {
    return failure(
      "internal",
      "SessionCwdService returned a non-absolute working directory",
    );
  }
  return success(path.resolve(cwd, filePath));
}
