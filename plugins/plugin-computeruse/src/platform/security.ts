import fs from "node:fs";
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
  /^ELIZA_.*(?:SECRET|KEY|TOKEN)/i,
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

  const home = os.homedir().replace(/\\/g, "/");
  const relativeToHome = normalized.startsWith(`${home}/`)
    ? normalized.slice(home.length)
    : null;
  if (relativeToHome) {
    for (const { pattern, label } of CREDENTIAL_PATTERNS) {
      if (pattern.test(relativeToHome)) {
        return {
          allowed: false,
          reason: `Blocked: "${path.basename(resolved)}" is a ${label} file.`,
        };
      }
    }
  }

  if (operation !== "read") {
    const patterns =
      process.platform === "win32"
        ? SYSTEM_DIR_PATTERNS_WIN32
        : SYSTEM_DIR_PATTERNS_UNIX;

    for (const { pattern, label } of patterns) {
      if (pattern.test(normalized)) {
        return {
          allowed: false,
          reason: `Blocked: cannot ${operation} in ${label}.`,
        };
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
