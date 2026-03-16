/**
 * Security utilities for sandbox command and path validation.
 *
 * SECURITY MODEL:
 * - ALLOWED_COMMANDS: Whitelist of commands the AI can request via run_command tool
 * - BLOCKED_COMMAND_PATTERNS: Dangerous patterns blocked even if base command is allowed
 * - ALLOWED_DIRECTORIES: Directories where files can be written
 * - ALLOWED_ROOT_PATTERNS: Root-level files that can be written
 *
 * NOTE: Internal sandbox operations (curl for health checks, mkdir for directories)
 * are called directly via sandbox.runCommand() and bypass these checks intentionally.
 * Only AI-requested commands through the run_command tool are validated.
 */

// Commands the AI can request through the run_command tool
export const ALLOWED_COMMANDS = [
  "bun",
  "bunx",
  "pnpm",
  "npm",
  "npx",
  "node",
  "tsc",
  "next",
  "prettier",
  "eslint",
  "cat",
  "ls",
  "pwd",
  "echo",
  "head",
  "tail",
  "grep",
  "find",
  "wc",
];

// Dangerous command patterns that are always blocked
export const BLOCKED_COMMAND_PATTERNS = [
  /rm\s+(-rf?|--recursive)/i,
  /curl\s/i, // AI shouldn't make network requests
  /wget\s/i,
  /chmod\s/i,
  /chown\s/i,
  /sudo\s/i,
  /eval\s/i,
  /exec\s/i,
  /\|\s*(bash|sh|zsh)/i, // Piping to shell
  />\s*\/etc\//i, // Writing to system dirs
  /\.env(?!\.(example|sample|template|local)\b)/i, // Env files (except examples and .env.local)
  /process\.env/i,
  /export\s+\w+=/i,
];

// Directories where files can be written
export const ALLOWED_DIRECTORIES = [
  "src/",
  "app/",
  "components/",
  "lib/",
  "public/",
  "styles/",
  "pages/",
  "utils/",
  "hooks/",
  "types/",
  "context/",
  "store/",
  "services/",
  "api/",
  "layouts/",
  "templates/",
  "features/",
  "modules/",
  "assets/",
  "config/",
  // Database directories for stateful apps
  "db/",
  "drizzle/",
];

// Root-level file patterns that can be written
export const ALLOWED_ROOT_PATTERNS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^bun\.lockb$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^tsconfig.*\.json$/,
  /^next\.config\.(ts|js|mjs)$/,
  /^tailwind\.config\.(ts|js)$/,
  /^postcss\.config\.(js|mjs)$/,
  /^.*\.md$/,
  /^.*\.txt$/,
  /^LICENSE.*$/,
  /^\.gitignore$/,
  /^\.eslintrc\.(js|json)$/,
  /^eslint\.config\.(js|mjs)$/,
  /^\.prettierrc(\.json)?$/,
  /^prettier\.config\.(js|mjs)$/,
  /^\.editorconfig$/,
  /^\.nvmrc$/,
  /^\.node-version$/,
  /^\.env(\.[a-z]+)?\.example$/,
  // Database config for stateful apps
  /^drizzle\.config\.(ts|js)$/,
];

/**
 * Check if a command is allowed for AI execution.
 * Used to validate commands requested through the run_command tool.
 */
export function isCommandAllowed(command: string): {
  allowed: boolean;
  reason?: string;
} {
  const trimmed = command.trim();
  const baseCommand = trimmed.split(/\s+/)[0];

  // Check blocked patterns first
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: `Command contains blocked pattern: ${pattern}`,
      };
    }
  }

  // Check if base command is in allowlist
  if (!ALLOWED_COMMANDS.includes(baseCommand)) {
    return {
      allowed: false,
      reason: `Command '${baseCommand}' not in allowlist. Allowed: ${ALLOWED_COMMANDS.join(", ")}`,
    };
  }

  return { allowed: true };
}

/**
 * Check if a file path is allowed for writing.
 */
export function isPathAllowed(filePath: string): boolean {
  // Normalize path: remove ./ prefix and any ../ traversal attempts
  const normalized = filePath.replace(/^\.\//, "").replace(/\.\.\//g, "");

  // Block any remaining path traversal
  if (normalized.includes("..")) {
    return false;
  }

  // Check if path is in allowed directories
  if (ALLOWED_DIRECTORIES.some((dir) => normalized.startsWith(dir))) {
    return true;
  }

  // Check if it's an allowed root-level file (no directory)
  if (!normalized.includes("/")) {
    return ALLOWED_ROOT_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  return false;
}
