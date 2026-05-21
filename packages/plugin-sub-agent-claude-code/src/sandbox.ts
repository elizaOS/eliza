/**
 * Sub-agent hardening helpers (SOC2 A-2 + A-3).
 *
 * - `filterEnv` — explicit allowlist + token blocklist for child env.
 * - `resolveSafeCwd` — realpath validation; cwd must be under workspace or /tmp.
 * - `resolveSafeBinary` — `which` resolution against a static path whitelist.
 * - `buildSandboxedCommand` — wraps argv in sandbox-exec (macOS) or bwrap (Linux).
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, resolve, sep } from "node:path";

/** Env keys that may be forwarded to a sub-agent verbatim. */
export const SAFE_ENV_KEYS: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SHELL",
  "TERM",
  "USER",
  "LOGNAME",
]);

/**
 * Defensive blocklist applied to BOTH the inherited env subset (after
 * allowlist) and `extraEnv`. If a key matches this regex it is dropped.
 */
const SENSITIVE_ENV_RE =
  /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|DATABASE_URL|WALLET|PRIVATE|MNEMONIC|API_KEY)/i;

/** Whitelisted absolute directories that may host the sub-agent binary. */
const BINARY_DIR_ALLOWLIST: readonly string[] = [
  "/usr/local/bin",
  "/usr/bin",
  "/opt/homebrew/bin",
  `${homedir()}/.local/bin`,
  `${homedir()}/.bun/bin`,
  `${homedir()}/.cargo/bin`,
];

export interface FilterEnvOptions {
  /** Pre-validated extra env to layer on top of the allowlisted parent env. */
  extra?: Record<string, string | undefined>;
  /** Override the default `SAFE_ENV_KEYS`. */
  allow?: ReadonlySet<string>;
}

export function filterEnv(
  source: NodeJS.ProcessEnv,
  allow: ReadonlySet<string> = SAFE_ENV_KEYS,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allow) {
    const value = source[key];
    if (value === undefined) continue;
    if (SENSITIVE_ENV_RE.test(key)) continue;
    out[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_RE.test(key)) {
      throw new Error(
        `Refusing to forward sensitive env var to sub-agent: ${key}`,
      );
    }
    out[key] = value;
  }
  return out;
}

export class SubAgentCwdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubAgentCwdError";
  }
}

/**
 * Resolve `cwd` to its realpath and require it to live under one of
 * the supplied workspace roots OR `/tmp`. Symlink escapes are rejected.
 */
export function resolveSafeCwd(
  cwd: string,
  workspaceRoots: readonly string[],
): string {
  if (!cwd || typeof cwd !== "string") {
    throw new SubAgentCwdError("cwd is required");
  }
  if (!isAbsolute(cwd)) {
    throw new SubAgentCwdError(`cwd must be absolute: ${cwd}`);
  }
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new SubAgentCwdError(`cwd does not exist or is not a directory: ${cwd}`);
  }
  const real = realpathSync(cwd);
  const tmpReal = realpathSync(tmpdir());
  const candidates = [...workspaceRoots, tmpReal]
    .filter((root): root is string => typeof root === "string" && root.length > 0)
    .map((root) => {
      try {
        return realpathSync(root);
      } catch {
        return resolve(root);
      }
    });
  for (const root of candidates) {
    if (real === root || real.startsWith(root + sep)) return real;
  }
  throw new SubAgentCwdError(
    `cwd ${real} is not under any allowed workspace root (${candidates.join(", ")})`,
  );
}

export class SubAgentBinaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubAgentBinaryError";
  }
}

/**
 * Resolve `binary` (name or path) to an absolute path under the binary
 * whitelist. PATH lookup uses `which` semantics constrained to safe dirs.
 */
export function resolveSafeBinary(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!binary) throw new SubAgentBinaryError("binary is required");

  const candidateDirs = BINARY_DIR_ALLOWLIST.slice();

  let resolved: string | null = null;
  if (isAbsolute(binary)) {
    resolved = binary;
  } else if (binary.includes("/")) {
    throw new SubAgentBinaryError(
      `binary must be absolute or a bare name: ${binary}`,
    );
  } else {
    // `which`-style lookup, restricted to whitelisted dirs only.
    const pathDirs = (env.PATH ?? "").split(delimiter);
    for (const dir of pathDirs) {
      const real = (() => {
        try {
          return realpathSync(dir);
        } catch {
          return dir;
        }
      })();
      if (!candidateDirs.includes(real)) continue;
      const guess = `${real}${sep}${binary}`;
      if (existsSync(guess)) {
        resolved = guess;
        break;
      }
    }
    // Last-resort: scan whitelist directly.
    if (!resolved) {
      for (const dir of candidateDirs) {
        const guess = `${dir}${sep}${binary}`;
        if (existsSync(guess)) {
          resolved = guess;
          break;
        }
      }
    }
  }

  if (!resolved || !existsSync(resolved)) {
    throw new SubAgentBinaryError(
      `Could not resolve ${binary} under any whitelisted dir: ${candidateDirs.join(", ")}`,
    );
  }
  const real = realpathSync(resolved);
  const realDir = dirname(real);
  if (!candidateDirs.some((d) => realDir === d || realDir.startsWith(d + sep))) {
    throw new SubAgentBinaryError(
      `Resolved binary ${real} is not under a whitelisted dir`,
    );
  }
  return real;
}

export interface SandboxPlan {
  cmd: string[];
  /** Identifier of the sandbox layer in use; `"none"` when no helper available. */
  sandbox: "macos-sandbox-exec" | "linux-bwrap" | "none";
}

export interface SandboxOptions {
  workspaceRoot: string;
  sessionId: string;
  /** Path to a macOS .sb profile. Required on darwin. */
  macosProfile?: string;
  /** Path to the bwrap wrapper script. Required on linux. */
  linuxWrapper?: string;
}

/**
 * Build the final argv for spawning the sub-agent, prepended by an OS
 * sandbox helper when available. Returns `sandbox: "none"` and the raw
 * argv when no helper exists (Windows, or missing profile in dev) — the
 * caller MUST log a WARN in that case.
 */
export function buildSandboxedCommand(
  argv: string[],
  opts: SandboxOptions,
): SandboxPlan {
  if (process.platform === "darwin") {
    if (
      opts.macosProfile &&
      existsSync(opts.macosProfile) &&
      hasBinary("/usr/bin/sandbox-exec")
    ) {
      const cmd = [
        "/usr/bin/sandbox-exec",
        "-D",
        `WORKSPACE=${opts.workspaceRoot}`,
        "-D",
        `SESSION=${opts.sessionId}`,
        "-D",
        `HOME=${homedir()}`,
        "-D",
        `TMPDIR=${tmpdir()}`,
        "-f",
        opts.macosProfile,
        ...argv,
      ];
      return { cmd, sandbox: "macos-sandbox-exec" };
    }
    return { cmd: argv, sandbox: "none" };
  }
  if (process.platform === "linux") {
    if (
      opts.linuxWrapper &&
      existsSync(opts.linuxWrapper) &&
      hasBinary("/usr/bin/bwrap")
    ) {
      const cmd = [
        opts.linuxWrapper,
        opts.workspaceRoot,
        opts.sessionId,
        "--",
        ...argv,
      ];
      return { cmd, sandbox: "linux-bwrap" };
    }
    return { cmd: argv, sandbox: "none" };
  }
  // Windows: no built-in equivalent. Job Object limits are out of scope here.
  // TODO(soc2-a3-windows): integrate Job Object resource limits via FFI.
  return { cmd: argv, sandbox: "none" };
}

function hasBinary(absPath: string): boolean {
  try {
    return existsSync(absPath);
  } catch {
    return false;
  }
}

/** True iff the `bwrap` wrapper resolved cleanly to an executable file. */
export function isExecutable(path: string): boolean {
  try {
    const real = realpathSync(path);
    const stat = statSync(real);
    // 0o111 = any-execute bit.
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Best-effort discovery of the bundled sandbox profile paths relative to
 * the package root. Returns undefined when the file is missing so callers
 * can fall through to no-sandbox + WARN.
 */
export function locateBundledProfiles(packageRoot: string): {
  macosProfile?: string;
  linuxWrapper?: string;
} {
  const macos = resolve(packageRoot, "sandbox", "macos.sb");
  const linux = resolve(packageRoot, "sandbox", "linux-bwrap.sh");
  return {
    ...(existsSync(macos) ? { macosProfile: macos } : {}),
    ...(existsSync(linux) ? { linuxWrapper: linux } : {}),
  };
}

// Also export the secondary helper that `spawnSync('which', ...)` could
// have provided, in case future code wants a path-aware lookup.
export function which(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const r = spawnSync("/usr/bin/env", ["which", bin], {
    env,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  return out.length > 0 ? out : null;
}
