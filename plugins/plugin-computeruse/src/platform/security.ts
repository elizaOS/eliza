/**
 * Path and command security checks for computer-use: validates file targets
 * against allowed roots (resolving symlinks), flags dangerous shell commands, and
 * sanitizes the child-process environment before any spawn.
 */
import fs from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PathValidationResult {
  allowed: boolean;
  reason?: string;
}

export interface CommandRiskResult {
  blocked: boolean;
  reason?: string;
}

interface LabelledPattern {
  pattern: RegExp;
  label: string;
}

interface DangerousPattern {
  pattern: RegExp;
  reason: string;
}

const CREDENTIAL_PATTERNS: LabelledPattern[] = [
  {
    pattern: /^\/\.ssh\/(?:id_|.*\.pem$|authorized_keys$|config$)/i,
    label: "SSH key/config",
  },
  { pattern: /^\/\.gnupg\//i, label: "GPG keyring" },
  { pattern: /^\/\.aws\/credentials$/i, label: "AWS credentials" },
  {
    pattern: /^\/\.config\/gcloud\/application_default_credentials\.json$/i,
    label: "GCP credentials",
  },
  { pattern: /^\/\.docker\/config\.json$/i, label: "Docker credentials" },
  { pattern: /^\/\.kube\/config$/i, label: "Kubernetes config" },
  { pattern: /^\/\.netrc$/i, label: "netrc credentials" },
  { pattern: /^\/\.npmrc$/i, label: "npm credentials" },
  { pattern: /^\/\.git-credentials$/i, label: "Git stored credentials" },
  { pattern: /^\/Library\/Keychains\//i, label: "macOS Keychain" },
  {
    pattern:
      /\/(?:Google\/Chrome|Microsoft\/Edge|BraveSoftware\/Brave-Browser)\/.*\/Login Data$/i,
    label: "browser password database",
  },
  {
    pattern:
      /\/(?:Google\/Chrome|Microsoft\/Edge|BraveSoftware\/Brave-Browser)\/.*\/Cookies$/i,
    label: "browser cookie database",
  },
  {
    pattern:
      /\/\.mozilla\/firefox\/.*\/(?:logins\.json|key[34]\.db|cookies\.sqlite)$/i,
    label: "Firefox credential/cookie store",
  },
];

const SYSTEM_DIR_PATTERNS_WIN32: LabelledPattern[] = [
  { pattern: /^[A-Z]:\/Windows\//i, label: "Windows system directory" },
  { pattern: /^[A-Z]:\/Program Files/i, label: "Program Files directory" },
  { pattern: /^[A-Z]:\/ProgramData\//i, label: "ProgramData directory" },
  {
    pattern: /^[A-Z]:\/PROGRA~[1-4]\//i,
    label: "Program Files (8.3 short name)",
  },
];

const SYSTEM_DIR_PATTERNS_UNIX: LabelledPattern[] = [
  { pattern: /^\/boot\//i, label: "boot directory" },
  { pattern: /^\/sbin\//i, label: "system binary directory" },
  { pattern: /^\/usr\/sbin\//i, label: "system admin binary directory" },
  { pattern: /^\/usr\/lib\//i, label: "system library directory" },
  {
    pattern: /^\/etc\/(?:shadow|sudoers|pam\.d|master\.passwd)/i,
    label: "system auth config",
  },
  { pattern: /^\/System\//i, label: "macOS System directory" },
  {
    pattern: /^\/private\/var\/db\/dslocal/i,
    label: "macOS Directory Services",
  },
  { pattern: /^\/dev\//i, label: "device node" },
  { pattern: /^\/proc\//i, label: "proc filesystem" },
  { pattern: /^\/sys\//i, label: "sys filesystem" },
];

const WINDOWS_DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\..+)?$/i;

const STRIP_EXACT_ENV = new Set([
  "INTERNAL_API_KEY",
  "CSRF_SECRET",
  "ENCRYPTION_KEY",
  "SUPABASE_SERVICE_ROLE",
  "STRIPE_API_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "POSTHOG_API_KEY",
]);

const STRIP_PATTERN_ENV: RegExp[] = [
  /^SUPABASE_.*(?:SERVICE_ROLE|SECRET)/i,
  /^STRIPE_.*(?:SECRET|WEBHOOK)/i,
  /^ELIZA_.*(?:SECRET|KEY|TOKEN)/i,
  // LLM provider + connector credentials must not leak into spawned commands.
  /^(?:ANTHROPIC|OPENAI|OPENROUTER|GROQ|XAI|GOOGLE|GEMINI|GOOGLE_GENERATIVE_AI|ELEVENLABS|DEEPGRAM|MISTRAL|COHERE|DISCORD|TELEGRAM|SLACK|FARCASTER|TWITTER|AWS)_.*(?:KEY|TOKEN|SECRET|PASSWORD)/i,
  // Catch-all for credential-suffixed keys from any other provider/connector.
  /_(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)$/i,
];

const DANGEROUS_COMMAND_PATTERNS: DangerousPattern[] = [
  {
    pattern: /\brm\s+-[^\n;|&]*r[^\n;|&]*\s+\/(\s*$|\s*;|\s*&|\s*\|)/im,
    reason: "Recursive deletion of the root filesystem (rm -rf /).",
  },
  {
    pattern: /\brm\s+-[^\n;|&]*r[^\n;|&]*\s+\/\*/im,
    reason: "Recursive deletion of all root contents (rm -rf /*).",
  },
  {
    pattern: /\brm\s+-[^\n;|&]*r[^\n;|&]*\s+~\/?(\s|$|;|&|\|)/im,
    reason: "Recursive deletion of the entire home directory.",
  },
  {
    pattern:
      /\bRemove-Item\b(?=[^;|&]*-Recurse)(?=[^;|&]*[\s'"][A-Z]:[\\/](?=[^a-zA-Z0-9]|$))/im,
    reason: "PowerShell recursive deletion of drive root.",
  },
  {
    pattern:
      /\bRemove-Item\b(?=[^;|&]*-Recurse)(?=[^;|&]*[\s'"]\/{1,2}['"\s])/im,
    reason: "PowerShell recursive deletion of filesystem root.",
  },
  {
    pattern:
      /\b(?:powershell|pwsh)(?:\.exe)?\b[^|]*-(?:enc|encodedcommand)\b/im,
    reason: "Encoded PowerShell command.",
  },
  {
    pattern: /\bmkfs(?:\.\w+)?\s/i,
    reason: "Filesystem format command (mkfs).",
  },
  {
    pattern: /\bdd\s+[^;|&]*\bof=\/dev\/[hs]d/i,
    reason: "Raw disk write (dd of=/dev/sdX).",
  },
  {
    pattern: /:\(\)\s*\{[^}]*:\s*\|\s*:/,
    reason: "Fork bomb detected.",
  },
  {
    pattern: /\breg\s+delete\s+HKLM\\/i,
    reason: "System registry deletion.",
  },
];

/**
 * Build the set of "home-relative" candidate strings a credential pattern is
 * tested against. The anchored CREDENTIAL_PATTERNS (e.g. `^/.ssh/...`) expect a
 * path with the home root stripped, so we strip the agent's own home plus any
 * `/root` or `/home/<user>` prefix. The full normalized path is always included
 * so the non-anchored browser-store patterns continue to match anywhere.
 */
function credentialRelativePaths(normalized: string): string[] {
  const candidates = new Set<string>([normalized]);

  const home = os.homedir().replace(/\\/g, "/");
  if (home && normalized.startsWith(`${home}/`)) {
    candidates.add(normalized.slice(home.length));
  }

  // /root/... and /home/<user>/... — strip the home root so reads of other
  // users' (and root's) credential files are caught regardless of os.homedir().
  const otherHomeMatch = normalized.match(
    /^\/root(?=\/)|^\/home\/[^/]+(?=\/)/i,
  );
  if (otherHomeMatch) {
    candidates.add(normalized.slice(otherHomeMatch[0].length));
  }

  // /Users/<user>/... (macOS) home root.
  const macHomeMatch = normalized.match(/^\/Users\/[^/]+(?=\/)/i);
  if (macHomeMatch) {
    candidates.add(normalized.slice(macHomeMatch[0].length));
  }

  // C:/Users/<user>/... (Windows) home root. The optional leading path segment
  // lets POSIX test runners exercise Windows-style paths after path.resolve().
  const windowsHomeMatch = normalized.match(
    /(?:^|\/)[A-Z]:\/Users\/[^/]+(?=\/)/i,
  );
  if (windowsHomeMatch) {
    const root = windowsHomeMatch[0].startsWith("/")
      ? windowsHomeMatch[0].slice(1)
      : windowsHomeMatch[0];
    const rootIndex = normalized.indexOf(root);
    if (rootIndex >= 0) {
      candidates.add(normalized.slice(rootIndex + root.length));
    }
  }

  return [...candidates];
}

export function validateFilePath(
  filePath: string,
  operation: "read" | "write" | "delete",
): PathValidationResult {
  if (!filePath || typeof filePath !== "string") {
    return { allowed: false, reason: "No file path provided." };
  }

  if (filePath.includes("\0")) {
    return {
      allowed: false,
      reason: "Path contains null bytes (possible injection attack).",
    };
  }

  let resolved = path.resolve(filePath);
  if (resolved.startsWith("\\\\")) {
    return {
      allowed: false,
      reason: "Network (UNC) paths are blocked. Only local files are allowed.",
    };
  }

  if (process.platform === "win32" && /~\d/.test(resolved)) {
    try {
      const expanded = fs.realpathSync.native(resolved);
      if (expanded !== resolved) {
        resolved = expanded;
      }
    } catch {
      // Ignore nonexistent paths; the static blocklists still apply.
    }
  }

  const normalized = resolved.replace(/\\/g, "/");

  if (process.platform === "win32" && operation !== "read") {
    const basename = path.basename(resolved);
    if (WINDOWS_DEVICE_NAME.test(basename)) {
      return {
        allowed: false,
        reason: `Blocked: "${basename}" is a Windows reserved device name.`,
      };
    }
  }

  // Evaluate credential patterns against the path relative to ANY user's home
  // (the agent's own home, /root, and /home/<user>), not just the current home,
  // so reads of e.g. /root/.ssh/id_rsa or /home/other/.aws/credentials are
  // still blocked. The anchored patterns expect a "/.ssh/..." style suffix.
  for (const relativeToHome of credentialRelativePaths(normalized)) {
    for (const { pattern, label } of CREDENTIAL_PATTERNS) {
      if (pattern.test(relativeToHome)) {
        return {
          allowed: false,
          reason: `Blocked: "${path.basename(resolved)}" is a ${label} file.`,
        };
      }
    }
  }

  // Sensitive UNIX system paths (/etc/shadow, /proc, /sys, /dev, …) are blocked
  // for EVERY operation, including reads, so they cannot be exfiltrated via a
  // read. The Windows program-directory patterns stay write/delete-only because
  // reading config/log files there is a legitimate use case.
  if (process.platform !== "win32") {
    for (const { pattern, label } of SYSTEM_DIR_PATTERNS_UNIX) {
      if (pattern.test(normalized)) {
        return {
          allowed: false,
          reason: `Blocked: cannot ${operation} in ${label}.`,
        };
      }
    }
  }

  if (operation !== "read") {
    if (process.platform === "win32") {
      for (const { pattern, label } of SYSTEM_DIR_PATTERNS_WIN32) {
        if (pattern.test(normalized)) {
          return {
            allowed: false,
            reason: `Blocked: cannot ${operation} in ${label}.`,
          };
        }
      }
    }

    if (/^[A-Z]:\/?$/i.test(normalized) || normalized === "/") {
      return {
        allowed: false,
        reason: `Blocked: cannot ${operation} the filesystem root.`,
      };
    }
  }

  return { allowed: true };
}

export type SafeFileTargetResult = PathValidationResult & {
  resolvedPath?: string;
};

function errnoCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "";
}

/**
 * Resolve and re-validate file paths after lstat/realpath to reduce TOCTOU /
 * symlink escapes (GHSA-qmf5-p9x5-9xr5).
 */
export async function resolveSafeFileTarget(
  filePath: string,
  operation: "read" | "write" | "delete",
): Promise<SafeFileTargetResult> {
  const check = validateFilePath(filePath, operation);
  if (!check.allowed) {
    return check;
  }

  const resolved = path.resolve(filePath);

  try {
    const stat = await lstat(resolved);
    if (stat.isSymbolicLink()) {
      return {
        allowed: false,
        reason: "Symbolic links are not allowed for file operations.",
      };
    }
    const canonical = await realpath(resolved);
    const recheck = validateFilePath(canonical, operation);
    if (!recheck.allowed) {
      return recheck;
    }
    return { allowed: true, resolvedPath: canonical };
  } catch (error) {
    if (errnoCode(error) === "ENOENT" && operation === "read") {
      const fallback = validateFilePath(resolved, operation);
      if (!fallback.allowed) {
        return fallback;
      }
      return { allowed: true, resolvedPath: resolved };
    }

    if (errnoCode(error) === "ENOENT" && operation === "write") {
      const parent = path.dirname(resolved);
      try {
        const parentStat = await lstat(parent);
        if (parentStat.isSymbolicLink()) {
          return {
            allowed: false,
            reason: "Parent path is a symbolic link.",
          };
        }
        const parentReal = await realpath(parent);
        const target = path.join(parentReal, path.basename(resolved));
        const parentCheck = validateFilePath(target, operation);
        if (!parentCheck.allowed) {
          return parentCheck;
        }
        return { allowed: true, resolvedPath: target };
      } catch (parentError) {
        if (errnoCode(parentError) === "ENOENT") {
          const fallback = validateFilePath(resolved, operation);
          if (!fallback.allowed) {
            return fallback;
          }
          return { allowed: true, resolvedPath: resolved };
        }
        return {
          allowed: false,
          reason:
            parentError instanceof Error
              ? parentError.message
              : String(parentError),
        };
      }
    }

    return {
      allowed: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function sanitizeChildEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (STRIP_EXACT_ENV.has(key)) {
      delete env[key];
      continue;
    }
    for (const pattern of STRIP_PATTERN_ENV) {
      if (pattern.test(key)) {
        delete env[key];
        break;
      }
    }
  }
  return env;
}

export function checkDangerousCommand(command: string): CommandRiskResult {
  if (!command || typeof command !== "string") {
    return { blocked: false };
  }

  const trimmed = command.trim();
  for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        blocked: true,
        reason:
          `Command blocked: ${reason}\n` +
          "If you genuinely need to run this, execute it manually in a terminal.",
      };
    }
  }

  return { blocked: false };
}
