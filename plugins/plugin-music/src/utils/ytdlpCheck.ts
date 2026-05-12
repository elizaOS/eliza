import { execSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";

export const YTDLP_INSTALL_INSTRUCTIONS = `
yt-dlp is not installed or not found in PATH.

Installation instructions:

📦 Using pip in a venv (recommended on Debian/Ubuntu):
  python3 -m venv ~/venv && ~/venv/bin/pip install yt-dlp
  Then set: export YT_DLP_PATH=~/venv/bin/yt-dlp

📦 Using pipx (isolated installation):
  pipx install yt-dlp

📦 Using Homebrew (macOS):
  brew install yt-dlp

📦 Using apt (Debian/Ubuntu):
  sudo apt update && sudo apt install yt-dlp

📦 Using pacman (Arch Linux):
  sudo pacman -S yt-dlp

📦 Manual installation:
  1. Download from: https://github.com/yt-dlp/yt-dlp/releases/latest
  2. Make executable: chmod +x yt-dlp
  3. Move to PATH: sudo mv yt-dlp /usr/local/bin/

📖 Full documentation: https://github.com/yt-dlp/yt-dlp#installation

After installation, verify with: yt-dlp --version
`;

export interface YtdlpCheckResult {
  found: boolean;
  path: string | null;
  error?: string;
}

/** Env var to force a specific yt-dlp executable (e.g. from a venv: /root/venv/bin/yt-dlp) */
const YT_DLP_PATH_ENV = "YT_DLP_PATH";

/** Cache the resolved path so the expensive check only runs once per process. */
let cachedPath: string | null | undefined;

function resolveYtdlpPathFromEnv(): string | null {
  const path = process.env[YT_DLP_PATH_ENV]?.trim();
  if (!path) return null;
  if (existsSync(path)) {
    return path;
  }
  return null;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the list of candidate paths to check.
 * Searches workspace scripts/bin, common system paths, and PATH.
 */
function getCandidatePaths(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      candidates.push(p);
    }
  };

  // Walk up from module dir (handles both source and bundled dist layouts)
  for (let depth = 2; depth <= 5; depth++) {
    add(
      resolve(
        moduleDir,
        ...Array(depth).fill(".."),
        "scripts",
        "bin",
        "yt-dlp",
      ),
    );
  }
  add(resolve(process.cwd(), "scripts", "bin", "yt-dlp"));

  add("/usr/local/bin/yt-dlp");
  add("/usr/bin/yt-dlp");
  add("/opt/homebrew/bin/yt-dlp");

  return candidates;
}

/**
 * Check if yt-dlp is available and return its path.
 *
 * Uses `existsSync` + `accessSync(X_OK)` instead of running `--version`,
 * because the macOS PyInstaller binary has a ~10 s cold start that
 * exceeds reasonable `execSync` timeouts.
 */
export async function checkYtdlpAvailable(): Promise<YtdlpCheckResult> {
  if (cachedPath !== undefined) {
    return cachedPath
      ? { found: true, path: cachedPath }
      : { found: false, path: null, error: "yt-dlp executable not found" };
  }

  // 1. Env override
  const envPath = resolveYtdlpPathFromEnv();
  if (envPath && isExecutable(envPath)) {
    logger.debug(`Using yt-dlp from YT_DLP_PATH: ${envPath}`);
    cachedPath = envPath;
    return { found: true, path: envPath };
  }

  // 2. Known filesystem paths — just check existence + execute bit
  for (const candidate of getCandidatePaths()) {
    if (existsSync(candidate) && isExecutable(candidate)) {
      logger.debug(`Found yt-dlp at: ${candidate}`);
      cachedPath = candidate;
      return { found: true, path: candidate };
    }
  }

  // 3. Try PATH via `command -v` (fast, no cold-start penalty)
  try {
    const commandPath = execSync("command -v yt-dlp", {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (commandPath && existsSync(commandPath)) {
      logger.debug(`Found yt-dlp via PATH: ${commandPath}`);
      cachedPath = commandPath;
      return { found: true, path: commandPath };
    }
  } catch {
    // not on PATH
  }

  cachedPath = null;
  return {
    found: false,
    path: null,
    error: "yt-dlp executable not found in PATH",
  };
}

/**
 * Get yt-dlp path or throw error with installation instructions
 */
export async function getYtdlpPath(): Promise<string> {
  const check = await checkYtdlpAvailable();

  if (!check.found || !check.path) {
    throw new Error(
      `yt-dlp is required for audio playback but was not found.\n${YTDLP_INSTALL_INSTRUCTIONS}`,
    );
  }

  return check.path;
}

/**
 * Synchronous variant for quick checks.
 */
export function checkYtdlpAvailableSync(): YtdlpCheckResult {
  if (cachedPath !== undefined) {
    return cachedPath
      ? { found: true, path: cachedPath }
      : { found: false, path: null, error: "yt-dlp executable not found" };
  }

  const envPath = resolveYtdlpPathFromEnv();
  if (envPath && isExecutable(envPath)) {
    cachedPath = envPath;
    return { found: true, path: envPath };
  }

  for (const candidate of getCandidatePaths()) {
    if (existsSync(candidate) && isExecutable(candidate)) {
      cachedPath = candidate;
      return { found: true, path: candidate };
    }
  }

  try {
    const commandPath = execSync("command -v yt-dlp", {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (commandPath && existsSync(commandPath)) {
      cachedPath = commandPath;
      return { found: true, path: commandPath };
    }
  } catch {
    // not found
  }

  cachedPath = null;
  return {
    found: false,
    path: null,
    error: "yt-dlp executable not found in PATH",
  };
}
