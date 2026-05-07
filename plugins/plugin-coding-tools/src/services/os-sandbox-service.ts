import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type IAgentRuntime, Service, logger as coreLogger } from "@elizaos/core";
import { CODING_TOOLS_LOG_PREFIX, OS_SANDBOX_SERVICE } from "../types.js";

/**
 * Platform-specific process sandboxing layer.
 *
 * AST analysis (BashAstService) catches most of what we care about before
 * spawn — dangerous syntax, env hijacks, eval, etc. This service adds a
 * second OS-enforced perimeter so a command that *parses* clean still can't
 * write to /etc, install kernel extensions, or open arbitrary network
 * sockets at runtime.
 *
 * Implementation:
 *   - macOS  → `sandbox-exec` with a generated profile that allows the
 *              defaults but denies file-write under system paths and
 *              optionally denies network. Profile written to a tempfile
 *              per-spawn and deleted in finally.
 *   - Linux  → `bwrap` (bubblewrap) when /usr/bin/bwrap exists. Runs the
 *              command inside a namespace that read-only-binds /, binds the
 *              workspace read-write, and unshares pid + (optionally)
 *              network. When bwrap is missing, falls back to passthrough
 *              (and logs once).
 *   - Windows / unknown → passthrough; AST analysis is the only layer.
 *
 * Opt-in via runtime setting `CODING_TOOLS_OS_SANDBOX=true`. Defaults to
 * off so existing automations don't break.
 */

export type SandboxKind = "sandbox-exec" | "bwrap" | "none";

export interface WrapOptions {
  command: string;
  cwd: string;
  roots: string[];
  allowNetwork?: boolean;
  bashBinary?: string;
}

export interface WrapResult {
  binary: string;
  args: string[];
  cleanup: () => void;
  kind: SandboxKind;
}

const SYSTEM_DENY_PATHS_DARWIN = [
  "/etc",
  "/usr/bin",
  "/usr/sbin",
  "/usr/libexec",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/System",
  "/bin",
  "/sbin",
  "/Library/LaunchDaemons",
  "/Library/LaunchAgents",
  "/private/etc",
  "/var/db",
  "/var/root",
];

export class OsSandboxService extends Service {
  static serviceType = OS_SANDBOX_SERVICE;
  capabilityDescription =
    "Wraps shell commands in a per-OS process sandbox (sandbox-exec / bwrap) when available.";

  private kind: SandboxKind = "none";
  private warnedUnavailable = false;

  static async start(runtime: IAgentRuntime): Promise<OsSandboxService> {
    const svc = new OsSandboxService(runtime);
    svc.detect();
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} OsSandboxService: kind=${svc.kind} platform=${process.platform}`,
    );
    return svc;
  }

  async stop(): Promise<void> {
    // no-op
  }

  private detect(): void {
    if (process.platform === "darwin") {
      // sandbox-exec ships with macOS at /usr/bin/sandbox-exec.
      if (existsSync("/usr/bin/sandbox-exec")) {
        this.kind = "sandbox-exec";
        return;
      }
    } else if (process.platform === "linux") {
      const candidates = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"];
      for (const p of candidates) {
        if (existsSync(p)) {
          this.kind = "bwrap";
          return;
        }
      }
    }
    this.kind = "none";
  }

  isAvailable(): boolean {
    return this.kind !== "none";
  }

  detectedKind(): SandboxKind {
    return this.kind;
  }

  /**
   * Returns wrapping for `/bin/bash -c <command>` so the caller can spawn
   * with the returned `{binary, args}` exactly as it would have spawned bash
   * directly. `cleanup()` removes any temp profile written for the call.
   *
   * If the platform has no available sandbox, returns the original bash
   * invocation with kind="none".
   */
  wrap(opts: WrapOptions): WrapResult {
    const bash = opts.bashBinary ?? "/bin/bash";
    const passthrough = (): WrapResult => ({
      binary: bash,
      args: ["-c", opts.command],
      cleanup: () => undefined,
      kind: "none",
    });

    if (this.kind === "sandbox-exec") {
      return this.wrapDarwin(opts, bash) ?? passthrough();
    }
    if (this.kind === "bwrap") {
      return this.wrapLinux(opts, bash) ?? passthrough();
    }
    if (!this.warnedUnavailable) {
      this.warnedUnavailable = true;
      coreLogger.warn(
        `${CODING_TOOLS_LOG_PREFIX} OS sandbox unavailable on ${process.platform}; running with AST-only validation.`,
      );
    }
    return passthrough();
  }

  private wrapDarwin(opts: WrapOptions, bash: string): WrapResult | undefined {
    try {
      const profile = buildDarwinProfile(opts);
      const dir = mkdtempSync(path.join(os.tmpdir(), "coding-tools-sbx-"));
      const profilePath = path.join(dir, "profile.sb");
      writeFileSync(profilePath, profile, "utf8");
      return {
        binary: "/usr/bin/sandbox-exec",
        args: ["-f", profilePath, bash, "-c", opts.command],
        cleanup: () => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // ignore
          }
        },
        kind: "sandbox-exec",
      };
    } catch (err) {
      coreLogger.warn(
        `${CODING_TOOLS_LOG_PREFIX} sandbox-exec wrap failed (${(err as Error).message}); falling back to passthrough.`,
      );
      return undefined;
    }
  }

  private wrapLinux(opts: WrapOptions, bash: string): WrapResult | undefined {
    const args: string[] = [];
    args.push("--ro-bind", "/", "/");
    for (const root of opts.roots) {
      args.push("--bind", root, root);
    }
    args.push("--bind", opts.cwd, opts.cwd);
    args.push("--tmpfs", "/tmp");
    args.push("--proc", "/proc");
    args.push("--dev", "/dev");
    args.push("--unshare-pid");
    args.push("--unshare-uts");
    args.push("--unshare-ipc");
    args.push("--new-session");
    args.push("--die-with-parent");
    if (!opts.allowNetwork) {
      args.push("--unshare-net");
    }
    args.push("--chdir", opts.cwd);
    args.push("--", bash, "-c", opts.command);
    return {
      binary: "/usr/bin/bwrap",
      args,
      cleanup: () => undefined,
      kind: "bwrap",
    };
  }
}

function buildDarwinProfile(opts: WrapOptions): string {
  // Strategy: start with `allow default` and layer `deny` for the specific
  // operations we want to block. sandbox-exec on macOS Sonoma+ has retired
  // some predicates (system-mount, system-kext-*); we stick to the stable
  // surface — file-write*, network-outbound, network-bind — which all
  // versions accept. The AST analyzer is the primary defense; this is the
  // OS-level perimeter for the path-write class of attacks.
  const lines: string[] = [];
  lines.push("(version 1)");
  lines.push("(allow default)");
  lines.push("(deny file-write*");
  for (const p of SYSTEM_DENY_PATHS_DARWIN) {
    lines.push(`  (subpath ${quote(p)})`);
  }
  lines.push(")");
  if (!opts.allowNetwork) {
    lines.push("(deny network-outbound)");
    lines.push("(deny network-bind)");
    lines.push('(allow network-outbound (local ip "localhost:*"))');
    lines.push('(allow network-bind (local ip "localhost:*"))');
    // Unix domain sockets are needed for many local daemons (e.g. dyld
    // shared cache, syslog). Permit them.
    lines.push("(allow network* (local unix-socket))");
    lines.push("(allow network* (remote unix-socket))");
  }
  return lines.join("\n");
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Best-effort syntactic check of a generated darwin profile. Used by tests.
 * Returns true if `sandbox-exec` accepts the profile (parses cleanly).
 */
export function smokeCheckDarwinProfile(profile: string): boolean {
  if (process.platform !== "darwin") return true;
  if (!existsSync("/usr/bin/sandbox-exec")) return true;
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), "coding-tools-sbx-check-"));
    const p = path.join(dir, "p.sb");
    writeFileSync(p, profile, "utf8");
    execFileSync("/usr/bin/sandbox-exec", ["-f", p, "/usr/bin/true"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}
