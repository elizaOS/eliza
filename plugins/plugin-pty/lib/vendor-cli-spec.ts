import { existsSync } from "node:fs";
import path from "node:path";
import type { PtySpawnSpec } from "../services/pty-types";

/**
 * Spawn specs for the EXPERIMENTAL vendor-CLI tier (#10832 Phase 2): the real
 * interactive **Claude Code** / **Codex** CLIs in a PTY, authenticating with
 * the user's OWN subscription credentials. Running a vendor CLI on a
 * subscription is the TOS-unsafe tier, so the spawn route only reaches these
 * builders behind `PTY_VENDOR_CLI_ENABLED` (default OFF) — and never on store
 * builds.
 *
 * Credential paths reuse the conventions of the existing subscription plugins:
 *   • claude — `plugin-anthropic-proxy`'s loader order: `CLAUDE_CODE_OAUTH_TOKEN`
 *     env first, else the CLI reads `~/.claude/.credentials.json` itself (the
 *     PTY inherits HOME). The token is passed through opaquely, never parsed
 *     or logged.
 *   • codex — `plugin-codex-cli`'s auth cache `~/.codex/auth.json`; an explicit
 *     `CODEX_HOME` (the per-account dir convention used by
 *     coding-account-bridge) is passed through when configured.
 *
 * Both CLIs are launched PLAIN (no args): the interactive TUI, not the
 * `claude --print` / `codex exec` one-shot paths.
 */

/** Session kinds served by the vendor-CLI tier. */
export type PtyVendorCliKind = "claude" | "codex";

export interface ClaudeCliSpecOptions {
  /** Working directory the interactive session runs in (confined to this). */
  cwd: string;
  /** Absolute path to the resolved `claude` launcher. */
  binPath: string;
  /**
   * Long-lived Claude Code OAuth token, passed through as
   * `CLAUDE_CODE_OAUTH_TOKEN` — the same env credential path
   * plugin-anthropic-proxy's loader reads first. When unset the CLI reads
   * `~/.claude/.credentials.json` itself via the inherited HOME.
   */
  oauthToken?: string;
  /** Extra env overrides merged last (tests / advanced callers). */
  extraEnv?: Record<string, string | undefined>;
}

/** Builds the interactive `claude` spawn spec. Pure — no I/O, no process spawn. */
export function buildClaudeCliSpec(opts: ClaudeCliSpecOptions): PtySpawnSpec {
  if (!opts.cwd?.trim()) {
    throw new Error("claude interactive session requires a cwd.");
  }
  if (!opts.binPath?.trim()) {
    throw new Error(
      "claude interactive session requires a resolved binPath (the claude launcher).",
    );
  }
  const cwd = path.resolve(opts.cwd);
  const oauthToken = opts.oauthToken?.trim();

  return {
    command: opts.binPath,
    args: [],
    cwd,
    env: {
      ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
      ...(opts.extraEnv ?? {}),
    },
    label: "claude · interactive",
    kind: "claude",
  };
}

export interface CodexCliSpecOptions {
  /** Working directory the interactive session runs in (confined to this). */
  cwd: string;
  /** Absolute path to the resolved `codex` launcher. */
  binPath: string;
  /**
   * Directory holding the Codex CLI's `auth.json`, passed through as
   * `CODEX_HOME` (the per-account convention used by coding-account-bridge).
   * When unset the CLI reads `~/.codex/auth.json` via the inherited HOME.
   */
  codexHome?: string;
  /** Extra env overrides merged last (tests / advanced callers). */
  extraEnv?: Record<string, string | undefined>;
}

/** Builds the interactive `codex` spawn spec. Pure — no I/O, no process spawn. */
export function buildCodexCliSpec(opts: CodexCliSpecOptions): PtySpawnSpec {
  if (!opts.cwd?.trim()) {
    throw new Error("codex interactive session requires a cwd.");
  }
  if (!opts.binPath?.trim()) {
    throw new Error(
      "codex interactive session requires a resolved binPath (the codex launcher).",
    );
  }
  const cwd = path.resolve(opts.cwd);
  const codexHome = opts.codexHome?.trim();

  return {
    command: opts.binPath,
    args: [],
    cwd,
    env: {
      ...(codexHome ? { CODEX_HOME: codexHome } : {}),
      ...(opts.extraEnv ?? {}),
    },
    label: "codex · interactive",
    kind: "codex",
  };
}

interface VendorBinResolveOptions {
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
}

/**
 * Resolves a vendor CLI launcher. Order:
 *   1. explicit env override (absolute path, must exist),
 *   2. first `PATH` entry containing the binary name.
 * Throws with actionable guidance when it can't be found.
 */
function resolveVendorCliBin(
  opts: VendorBinResolveOptions | undefined,
  binName: string,
  overrideKey: string,
  installHint: string,
): string {
  const env = opts?.env ?? process.env;
  const exists = opts?.exists ?? existsSync;

  const override = env[overrideKey]?.trim();
  if (override) {
    if (!exists(override)) {
      throw new Error(
        `${overrideKey} is set to "${override}" but no file exists there.`,
      );
    }
    return path.resolve(override);
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binName);
    if (exists(candidate)) return candidate;
  }

  throw new Error(
    `Could not locate the ${binName} CLI on PATH. Install it ` +
      `(${installHint}) or set ${overrideKey} to its absolute path.`,
  );
}

/** Resolves the `claude` launcher: `PTY_CLAUDE_BIN` override, else PATH. */
export function resolveClaudeCliBin(opts?: VendorBinResolveOptions): string {
  return resolveVendorCliBin(
    opts,
    "claude",
    "PTY_CLAUDE_BIN",
    "npm install -g @anthropic-ai/claude-code",
  );
}

/** Resolves the `codex` launcher: `PTY_CODEX_BIN` override, else PATH. */
export function resolveCodexCliBin(opts?: VendorBinResolveOptions): string {
  return resolveVendorCliBin(
    opts,
    "codex",
    "PTY_CODEX_BIN",
    "npm install -g @openai/codex",
  );
}
