import { homedir } from "node:os";
import * as path from "node:path";
import {
  logger as coreLogger,
  type IAgentRuntime,
  Service,
} from "@elizaos/core";
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
 * data plus per-OS system paths (system binaries, kernel/boot files,
 * Windows AppData crypto + cert stores).
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
    await svc.loadConfig();
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} SandboxService: blocking ${svc.blockedPaths.length} path(s)`,
    );
    return svc;
  }

  async stop(): Promise<void> {
    this.blockedPaths = [];
  }

  private async loadConfig(): Promise<void> {
    const replace = this.runtime.getSetting?.("CODING_TOOLS_BLOCKED_PATHS");
    const additions = this.runtime.getSetting?.(
      "CODING_TOOLS_BLOCKED_PATHS_ADD",
    );
    let paths: string[];
    if (typeof replace === "string" && replace.trim().length > 0) {
      paths = parseList(replace);
    } else {
      paths = defaultBlockedPaths();
    }
    if (typeof additions === "string" && additions.trim().length > 0) {
      paths = paths.concat(parseList(additions));
    }
    // realpath each path so macOS /var ↔ /private/var (and Linux symlinked
    // paths) match correctly against realpath-resolved targets in
    // validatePath.
    const resolved = await Promise.all(
      paths.map(async (p) => resolveRealPath(path.resolve(expandHome(p)))),
    );
    this.blockedPaths = dedupe(resolved);
  }

  /**
   * Return the active blocklist (resolved absolute paths). Used by tests and
   * the available-tools provider.
   */
  getBlockedPaths(): string[] {
    return this.blockedPaths.slice();
  }

  /**
   * No-ops kept for API compatibility with worktree actions that previously
   * tracked allowed roots. The current sandbox model is blocklist-only.
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
  // User-private home subdirs we never want the agent to touch on any OS.
  const userHome = [
    path.join(home, "pvt"),
    path.join(home, "Library"),
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".docker"),
    path.join(home, ".kube"),
    path.join(home, ".netrc"),
  ];

  switch (process.platform) {
    case "darwin":
      return [
        ...userHome,
        // /etc and /var symlink to /private/{etc,var} on macOS; realpath in
        // loadConfig handles that, so blocking either form catches both.
        "/System",
        "/Library/LaunchDaemons",
        "/Library/LaunchAgents",
        "/usr/bin",
        "/usr/sbin",
        "/usr/libexec",
        "/bin",
        "/sbin",
        "/etc",
        "/var/db",
        "/var/root",
      ];

    case "linux":
      return [
        ...userHome,
        "/etc",
        "/boot",
        "/sys",
        "/usr/bin",
        "/usr/sbin",
        "/bin",
        "/sbin",
        "/root",
        "/var/lib/dpkg",
        "/var/lib/apt",
      ];

    case "win32": {
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
      const programFilesX86 =
        process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
      const programData = process.env.ProgramData ?? "C:\\ProgramData";
      return [
        ...userHome,
        path.join(home, "AppData", "Roaming", "Microsoft", "Crypto"),
        path.join(home, "AppData", "Local", "Microsoft", "Credentials"),
        path.join(home, "AppData", "Roaming", "Microsoft", "Protect"),
        path.join(
          home,
          "AppData",
          "Roaming",
          "Microsoft",
          "SystemCertificates",
        ),
        systemRoot,
        programFiles,
        programFilesX86,
        programData,
      ];
    }

    default:
      return userHome;
  }
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
