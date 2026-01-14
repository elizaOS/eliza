import * as path from "node:path";

export const DEFAULT_FORBIDDEN_COMMANDS: string[] = [
  "rm -rf /",
  "rm -rf ~",
  "sudo rm",
  "mkfs",
  "dd if=/dev",
];

export function extractBaseCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  const first = trimmed.split(/\s+/)[0];
  return first ?? "";
}

/**
 * Very conservative “safe command” filter. Blocks shell control operators and
 * common escape patterns. (This is aligned with other plugins’ patterns.)
 */
export function isSafeCommand(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  if (c.includes("&&") || c.includes("||") || c.includes(";")) return false;
  if (c.includes("$(") || c.includes("`")) return false;
  return true;
}

export function isForbiddenCommand(
  command: string,
  additionalForbidden: string[],
): boolean {
  const c = command.toLowerCase();
  for (const f of DEFAULT_FORBIDDEN_COMMANDS) {
    if (c.includes(f.toLowerCase())) return true;
  }
  for (const f of additionalForbidden) {
    if (f.trim().length === 0) continue;
    if (c.includes(f.toLowerCase())) return true;
  }
  return false;
}

/**
 * Resolve a target path against the current directory while enforcing that
 * the result stays inside allowedDirectory.
 */
export function validatePath(
  targetPath: string,
  allowedDirectory: string,
  currentDirectory: string,
): string | null {
  const base =
    currentDirectory && currentDirectory.length > 0
      ? currentDirectory
      : allowedDirectory;
  const resolved = path.resolve(base, targetPath);
  const allowed = path.resolve(allowedDirectory);

  const rel = path.relative(allowed, resolved);
  if (rel === "") return resolved;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}
