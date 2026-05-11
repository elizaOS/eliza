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
 *   CODING_TOOLS_WORKSPACE_ROOTS=/abs1,/abs2    — optional comma-separated
 *     allow roots. When set, coding tools may only access paths under these
 *     roots after the blocklist check.
 *
 * Both `~` and `$HOME` are expanded.
 */
export class SandboxService extends Service {
  static serviceType = SANDBOX_SERVICE;
  capabilityDescription =
    "Path safety policy for coding tools. Blocks sensitive paths and optionally constrains access to configured workspace roots.";

  private blockedPaths: string[] = [];
  private allowedRoots: string[] = [];
  private conversationRoots = new Map<string, Set<string>>();

  static async start(runtime: IAgentRuntime): Promise<SandboxService> {
    const svc = new SandboxService(runtime);
    await svc.loadConfig();
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} SandboxService: blocking ${svc.blockedPaths.length} path(s), allow-roots=${svc.allowedRoots.length}`,
    );
    return svc;
  }

  async stop(): Promise<void> {
    this.blockedPaths = [];
    this.allowedRoots = [];
    this.conversationRoots.clear();
  }

  private async loadConfig(): Promise<void> {
    const replace = readStringSetting(
      this.runtime,
      "CODING_TOOLS_BLOCKED_PATHS",
    );
    const additions = readStringSetting(
      this.runtime,
      "CODING_TOOLS_BLOCKED_PATHS_ADD",
    );
    const allowedRoots = readStringSetting(
      this.runtime,
      "CODING_TOOLS_WORKSPACE_ROOTS",
    );
    let paths: string[];
    if (replace && replace.trim().length > 0) {
      paths = parseList(replace);
    } else {
      paths = defaultBlockedPaths();
    }
    if (additions && additions.trim().length > 0) {
      paths = paths.concat(parseList(additions));
    }
    // realpath each path so macOS /var ↔ /private/var (and Linux symlinked
    // paths) match correctly against realpath-resolved targets in
    // validatePath.
    const resolved = await Promise.all(
      paths.map(async (p) => resolveRealPath(path.resolve(expandHome(p)))),
    );
    this.blockedPaths = dedupe(resolved);

    const resolvedAllowedRoots =
      allowedRoots && allowedRoots.trim().length > 0
        ? await Promise.all(
            parseList(allowedRoots).map(async (p) =>
              resolveRealPath(path.resolve(expandHome(p))),
            ),
          )
        : [];
    this.allowedRoots = dedupe(resolvedAllowedRoots);
  }

  /**
   * Return the active blocklist (resolved absolute paths). Used by tests and
   * the available-tools provider.
   */
  getBlockedPaths(): string[] {
    return this.blockedPaths.slice();
  }

  /**
   * Return globally configured allow roots (resolved absolute paths).
   * Conversation-scoped roots are intentionally omitted unless a conversation
   * id is provided.
   */
  getAllowedRoots(conversationId?: string): string[] {
    return this.resolveAllowedRoots(conversationId).slice();
  }

  addRoot(conversationId: string | undefined, absPath: string): void {
    if (!conversationId || !isAbsolutePath(absPath) || isUncPath(absPath)) {
      return;
    }
    const roots = this.conversationRoots.get(conversationId) ?? new Set();
    roots.add(path.resolve(expandHome(absPath)));
    this.conversationRoots.set(conversationId, roots);
  }

  removeRoot(conversationId: string | undefined, absPath: string): void {
    if (!conversationId || !isAbsolutePath(absPath) || isUncPath(absPath)) {
      return;
    }
    const roots = this.conversationRoots.get(conversationId);
    if (!roots) return;
    roots.delete(path.resolve(expandHome(absPath)));
    if (roots.size === 0) {
      this.conversationRoots.delete(conversationId);
    }
  }

  async validatePath(
    conversationId: string | undefined,
    absPath: string,
  ): Promise<
    | { ok: true; resolved: string }
    | {
        ok: false;
        reason:
          | "not_absolute"
          | "unc_path"
          | "blocked"
          | "outside_allowed_roots";
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
    const allowedRoots = this.resolveAllowedRoots(conversationId);
    if (allowedRoots.length > 0) {
      const underAllowedRoot = allowedRoots.some(
        (root) => isWithin(resolved, root) || resolved === root,
      );
      if (!underAllowedRoot) {
        return {
          ok: false,
          reason: "outside_allowed_roots",
          message: `Path ${absPath} is outside the configured coding workspace roots.`,
        };
      }
    }
    return { ok: true, resolved };
  }

  private resolveAllowedRoots(conversationId?: string): string[] {
    const roots = [...this.allowedRoots];
    if (conversationId) {
      const scoped = this.conversationRoots.get(conversationId);
      if (scoped) roots.push(...scoped);
    }
    return dedupe(roots);
  }
}

function readStringSetting(
  runtime: IAgentRuntime,
  key: string,
): string | undefined {
  const fromRuntime = runtime.getSetting?.(key);
  if (typeof fromRuntime === "string" && fromRuntime.trim().length > 0) {
    return fromRuntime;
  }
  const fromEnv = process.env[key];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  return undefined;
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

  if (isAndroidRuntime()) {
    return [
      ...userHome,
      "/apex",
      "/config",
      "/dev",
      "/etc",
      "/metadata",
      "/mnt/runtime",
      "/mnt/vendor",
      "/odm",
      "/proc",
      "/product",
      "/sys",
      "/system",
      "/vendor",
      "/data/misc",
      "/data/system",
      "/data/vendor",
    ];
  }

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

function isAndroidRuntime(): boolean {
  return (
    process.env.ELIZA_PLATFORM?.trim().toLowerCase() === "android" ||
    Boolean(process.env.ANDROID_ROOT || process.env.ANDROID_DATA)
  );
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
