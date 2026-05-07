import * as path from "node:path";
import { type IAgentRuntime, Service, logger as coreLogger } from "@elizaos/core";
import {
  isAbsolutePath,
  isBlockedPath,
  isUncPath,
  isWithinAnyRoot,
  resolveRealPath,
} from "../lib/path-utils.js";
import { CODING_TOOLS_LOG_PREFIX, SANDBOX_SERVICE } from "../types.js";

const DEFAULT_DENY_COMMAND_PATTERNS = [
  /\brm\s+-rf\s+\/(?:\s|$)/,
  /\brm\s+-rf\s+~(?:\/|\s|$)/,
  /\brm\s+-rf\s+\$HOME/,
  /\bsudo\s+/,
  /\bmkfs\b/,
  /\bdd\s+if=.+of=\/dev\//,
  /\b:\s*\(\s*\)\s*\{/, // fork bomb
  /\bcurl\s+.*\|\s*(?:bash|sh|zsh)\b/,
  /\bwget\s+.*\|\s*(?:bash|sh|zsh)\b/,
  /\bchmod\s+-R\s+777\b/,
  /\bchown\s+-R\s+root\b/,
  />\s*\/dev\/sd[a-z]/,
];

/**
 * Path + command validation for all coding tools.
 *
 * Roots model: every path operation must resolve (via realpath) to a location
 * within at least one configured workspace root. Default roots: process.cwd().
 * Override via `CODING_TOOLS_WORKSPACE_ROOTS` runtime setting (comma-separated
 * absolute paths) or `addRoot()` at runtime (used by EnterWorktree, etc.).
 */
export class SandboxService extends Service {
  static serviceType = SANDBOX_SERVICE;
  capabilityDescription =
    "Path validation, workspace-root sealing, and command denylist for coding tools.";

  private rootsByConversation = new Map<string, Set<string>>();
  private defaultRoots: string[] = [];
  private extraDenyPatterns: RegExp[] = [];

  static async start(runtime: IAgentRuntime): Promise<SandboxService> {
    const svc = new SandboxService(runtime);
    svc.loadConfig();
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} SandboxService started (default roots: ${svc.defaultRoots.join(", ") || "<empty>"})`,
    );
    return svc;
  }

  async stop(): Promise<void> {
    this.rootsByConversation.clear();
  }

  private loadConfig(): void {
    const raw = this.runtime.getSetting?.("CODING_TOOLS_WORKSPACE_ROOTS");
    if (typeof raw === "string" && raw.trim().length > 0) {
      this.defaultRoots = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => path.resolve(p));
    } else {
      this.defaultRoots = [path.resolve(process.cwd())];
    }
    const denyRaw = this.runtime.getSetting?.("CODING_TOOLS_DENY_COMMANDS");
    if (typeof denyRaw === "string" && denyRaw.trim().length > 0) {
      this.extraDenyPatterns = denyRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          try {
            return new RegExp(s);
          } catch {
            return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
          }
        });
    }
  }

  rootsFor(conversationId: string | undefined): string[] {
    if (!conversationId) return [...this.defaultRoots];
    const extra = this.rootsByConversation.get(conversationId);
    if (!extra || extra.size === 0) return [...this.defaultRoots];
    return [...this.defaultRoots, ...extra];
  }

  addRoot(conversationId: string, rootAbs: string): void {
    if (!isAbsolutePath(rootAbs)) {
      throw new Error(`addRoot requires absolute path, got ${rootAbs}`);
    }
    const set = this.rootsByConversation.get(conversationId) ?? new Set<string>();
    set.add(path.resolve(rootAbs));
    this.rootsByConversation.set(conversationId, set);
  }

  removeRoot(conversationId: string, rootAbs: string): void {
    const set = this.rootsByConversation.get(conversationId);
    if (!set) return;
    set.delete(path.resolve(rootAbs));
    if (set.size === 0) this.rootsByConversation.delete(conversationId);
  }

  async validatePath(
    conversationId: string | undefined,
    absPath: string,
  ): Promise<
    | { ok: true; resolved: string }
    | { ok: false; reason: "not_absolute" | "unc_path" | "blocked" | "outside_roots"; message: string }
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
    if (isBlockedPath(absPath)) {
      return {
        ok: false,
        reason: "blocked",
        message: `Path is on the system blocklist: ${absPath}`,
      };
    }
    const roots = this.rootsFor(conversationId);
    const within = await isWithinAnyRoot(absPath, roots);
    if (!within) {
      return {
        ok: false,
        reason: "outside_roots",
        message: `Path is outside the configured workspace roots (${roots.join(", ")}): ${absPath}`,
      };
    }
    const resolved = await resolveRealPath(absPath);
    return { ok: true, resolved };
  }

  validateCommand(
    command: string,
  ): { ok: true } | { ok: false; reason: "command_denied"; pattern: string; message: string } {
    for (const pat of DEFAULT_DENY_COMMAND_PATTERNS) {
      if (pat.test(command)) {
        return {
          ok: false,
          reason: "command_denied",
          pattern: pat.source,
          message: `Command matches built-in denylist /${pat.source}/`,
        };
      }
    }
    for (const pat of this.extraDenyPatterns) {
      if (pat.test(command)) {
        return {
          ok: false,
          reason: "command_denied",
          pattern: pat.source,
          message: `Command matches user denylist /${pat.source}/`,
        };
      }
    }
    return { ok: true };
  }
}
