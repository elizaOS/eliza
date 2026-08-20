/**
 * Path predicates and resolution used by the sandbox policy and file handlers.
 * Relative FILE inputs resolve through the conversation's session cwd.
 * `isBlockedPath` names device and `/proc/<pid>/fd` pseudo-paths but is not
 * yet wired into `validatePath` (tracked on #22944). Canonical
 * resolution and containment live in
 * `@elizaos/shared/platform/path-confinement` (fail-closed; see #22944).
 */
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

export function isUncPath(p: string): boolean {
  return p.startsWith("\\\\") || p.startsWith("//");
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
