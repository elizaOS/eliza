import { homedir } from "node:os";
import * as path from "node:path";
import { type IAgentRuntime, Service, logger as coreLogger } from "@elizaos/core";
import {
  isAbsolutePath,
  isUncPath,
  isWithin,
  resolveRealPath,
} from "../lib/path-utils.js";
import { CODING_TOOLS_LOG_PREFIX, SANDBOX_SERVICE } from "../types.js";

/**
 * Path-blocklist policy for the coding tools.
 *
 * Coding tools default to *trusted* mode: the agent can read and write
 * anywhere on disk EXCEPT a small list of paths that hold private user
 * data (SSH keys, cloud creds, GPG keyrings, the system Library tree).
 *
 * Configuration:
 *   CODING_TOOLS_BLOCKED_PATHS=/abs1,/abs2,...  — comma-separated absolute
 *     paths. Replaces the default list when set.
 *   CODING_TOOLS_BLOCKED_PATHS_ADD=/abs1,...    — comma-separated absolute
 *     paths to ADD to the default list (most common UI use).
 *
 * Both `~` and `$HOME` are expanded.
 */
export class SandboxService extends Service {
  static serviceType = SANDBOX_SERVICE;
  capabilityDescription =
    "Path blocklist policy for coding tools. Permits anything not under a blocked path.";

  private blockedPaths: string[] = [];

  static async start(runtime: IAgentRuntime): Promise<SandboxService> {
    const svc = new SandboxService(runtime);
    svc.loadConfig();
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} SandboxService: blocking ${svc.blockedPaths.length} path(s) ${svc.blockedPaths.join(", ")}`,
    );
    return svc;
  }

  async stop(): Promise<void> {
    this.blockedPaths = [];
  }

  private loadConfig(): void {
    const replace = this.runtime.getSetting?.("CODING_TOOLS_BLOCKED_PATHS");
    const additions = this.runtime.getSetting?.("CODING_TOOLS_BLOCKED_PATHS_ADD");
    let paths: string[];
    if (typeof replace === "string" && replace.trim().length > 0) {
      paths = parseList(replace);
    } else {
      paths = defaultBlockedPaths();
    }
    if (typeof additions === "string" && additions.trim().length > 0) {
      paths = paths.concat(parseList(additions));
    }
    this.blockedPaths = dedupe(paths.map((p) => path.resolve(expandHome(p))));
  }

  /**
   * Return the active blocklist (resolved absolute paths). Used by the
   * `available-tools` provider so the planner can surface what's blocked.
   */
  getBlockedPaths(): string[] {
    return this.blockedPaths.slice();
  }

  /**
   * No-op kept for API compatibility with callers that previously tracked
   * worktree roots. The current sandbox model is blocklist-only and has
   * no concept of allowed roots, so worktree entry/exit do not need to
   * register paths anywhere.
   */
  addRoot(_conversationId: string | undefined, _absPath: string): void {}

  removeRoot(_conversationId: string | undefined, _absPath: string): void {}

  async validatePath(
    _conversationId: string | undefined,
    absPath: string,
  ): Promise<
    | { ok: true; resolved: string }
    | {
        ok: false;
        reason: "not_absolute" | "unc_path" | "blocked";
        message: string;
      }
  > {
    if (!isAbsolutePath(absPath)) {
      return {
        ok: false,
        reason: "not_absolute",
        message: `Path must be absolute, got ${JSON.stringify(absPath)}`,
      };
    }
    if (isUncPath(absPath)) {
      return {
        ok: false,
        reason: "unc_path",
        message: `UNC paths are not permitted: ${absPath}`,
      };
    }
    const resolved = await resolveRealPath(absPath);
    for (const blocked of this.blockedPaths) {
      if (isWithin(resolved, blocked) || resolved === blocked) {
        return {
          ok: false,
          reason: "blocked",
          message: `Path ${absPath} is under blocked location ${blocked}.`,
        };
      }
    }
    return { ok: true, resolved };
  }
}

function parseList(s: string): string[] {
  return s
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  if (p.startsWith("$HOME/")) return path.join(homedir(), p.slice(6));
  return p;
}

function defaultBlockedPaths(): string[] {
  const home = homedir();
  return [
    path.join(home, "pvt"),
    path.join(home, "Library"),
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".docker"),
    path.join(home, ".kube"),
    path.join(home, ".netrc"),
  ];
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
